// A demo futures bot against a simulated Binance USD-M account: decimal leverage, exchange-side stop and target,
// exits the exchange makes on its own, the kill switch, and a position the bot did not open.
import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { protectiveLevels } from "../src/engine.js";
import { Clock, DeadWebSocket, FakeBinance, loadBars, noTimers, testConfig } from "./helpers.js";

const SEC = 900;
const bars = loadBars("btcusdt-15m.json");
const START = 2400;

async function setup(strategyExtra = {}, execExtra = {}) {
  const clock = new Clock((bars[START - 1].time + SEC) * 1000 + 3000);
  const fake = new FakeBinance({ clock, bars: { BTCUSDT: bars } });
  const app = createApp(testConfig(), { fetchImpl: fake.fetch, WebSocketImpl: DeadWebSocket, now: clock.now, quiet: true, ...noTimers });
  const bot = await app.manager.createBot({
    name: "demo kama",
    account: "demo",
    market: "futures",
    symbol: "BTCUSDT",
    timeframe: "15m",
    warmupBars: 1000,
    strategy: { kind: "ma_cross", maType: "KAMA", fast: 9, slow: 21, perpDirection: "both", takeProfitPct: 1.5, stopLossPct: 0.8, ...strategyExtra },
    execution: { capital: 1000, takerFeePercent: 0.05, makerFeePercent: 0.02, leverage: 2.5, maintenanceMarginPercent: 0.4, ...execExtra },
  });
  await app.manager.startBot(bot.id);
  const runner = app.manager.runners.get(bot.id);
  let i = START;
  /** Plays the next bar: the exchange's stops fire inside it, then it closes and the bot decides. */
  const step = async () => {
    fake.triggerStops("BTCUSDT", bars[i]);
    clock.ms = (bars[i].time + SEC) * 1000 + 3000;
    await app.feed.catchUp("futures:BTCUSDT:15m");
    await runner.queue;
    i++;
  };
  return { app, fake, clock, bot, runner, step, index: () => i };
}

test("start prepares the account: one-way mode, isolated margin, leverage rounded up", async () => {
  const { app, fake } = await setup();
  const keys = fake.calls.map((c) => c.key);
  assert.ok(keys.includes("GET /fapi/v1/positionSide/dual"));
  assert.equal(fake.marginType.get("BTCUSDT"), "ISOLATED");
  assert.equal(fake.leverage.get("BTCUSDT"), 3);
  assert.ok(fake.calls.every((c) => c.key.includes("klines") || c.key.includes("exchangeInfo") || c.key.includes("fundingRate") || c.key.includes("ticker") || c.host === "demo-fapi.binance.com"), "orders and account calls go to the demo host");
  await app.close();
});

test("an entry gets the engine's stop and target on the exchange and margin for 2.5x", async () => {
  const { app, fake, bot, step } = await setup();
  for (let k = 0; k < 300 && !app.store.openTrade(bot.id); k++) await step();
  const trade = app.store.openTrade(bot.id);
  assert.ok(trade, "the bot entered within 300 bars");
  const order = fake.calls.find((c) => c.key === "POST /fapi/v1/order");
  assert.equal(order.params.type, "MARKET");
  assert.equal(order.host, "demo-fapi.binance.com");
  const algos = [...fake.algo.values()];
  assert.equal(algos.length, 2);
  const lab = app.manager.runners.get(bot.id).lab;
  const venue = app.manager.runners.get(bot.id).venue;
  const levels = protectiveLevels(lab, venue.rules, trade.side, trade.entry_price);
  assert.equal(algos.find((a) => a.type === "STOP_MARKET").triggerPrice, levels.stopLoss);
  assert.equal(algos.find((a) => a.type === "TAKE_PROFIT_MARKET").triggerPrice, levels.takeProfit);
  assert.ok(algos.every((a) => a.closePosition === "true" && a.algoType === "CONDITIONAL"));
  const notional = trade.qty * trade.entry_price;
  assert.ok(Math.abs(fake.margin.get("BTCUSDT") - (notional / 2.5 - notional / 3)) < 0.01, "isolated margin topped up to notional / 2.5");
  assert.ok(notional <= 1000 * 2.5, "sized within 2.5x of the capital");
  assert.ok(notional > 1000 * 2.5 * 0.95, `sized near 2.5x of the capital (${notional.toFixed(2)})`);
  await app.close();
});

test("stops the exchange fills are booked; trading follows the engine across 500 bars", async () => {
  const { app, bot, step, runner } = await setup();
  for (let k = 0; k < 500; k++) await step();
  const trades = app.store.trades({ botId: bot.id, limit: 1e6 });
  const closed = trades.filter((t) => t.status === "closed");
  const reasons = new Set(closed.map((t) => t.exit_reason));
  assert.ok(reasons.has("STOP_LOSS") || reasons.has("TAKE_PROFIT"), `exchange-side exits seen: ${[...reasons]}`);
  const errors = app.store.events({ limit: 1e6 }).filter((e) => e.level === "error");
  assert.deepEqual(errors, []);
  assert.equal(app.store.getBot(bot.id).status, "running");
  // Every live entry is an engine entry on the same side at the next bar.
  const run = runner.backtestSinceAnchor();
  const engineEntries = new Map(run.trades.filter((t) => t.type === "ENTRY").map((t) => [t.time, t.side]));
  const live = trades.filter((t) => !t.manual);
  const matched = live.filter((t) => engineEntries.get(t.engine_bar_time + SEC) === t.side).length;
  assert.equal(matched, live.length, `${matched} of ${live.length} live entries are engine entries`);
  for (const t of closed) {
    const expected = (t.exit_price - t.entry_price) * t.qty * (t.side === "short" ? -1 : 1) - t.entry_fee - t.exit_fee + t.funding;
    assert.ok(Math.abs(t.pnl - expected) < 1e-9, "P&L is gross minus fees plus funding");
  }
  await app.close();
});

test("the kill switch refuses entries but exits still run", async () => {
  const { app, bot, step } = await setup();
  for (let k = 0; k < 300 && !app.store.openTrade(bot.id); k++) await step();
  assert.ok(app.store.openTrade(bot.id));
  await app.manager.setKillSwitch(true, { reason: "test" });
  const before = app.store.trades({ botId: bot.id, limit: 1e6 }).length;
  for (let k = 0; k < 200; k++) await step();
  const trades = app.store.trades({ botId: bot.id, limit: 1e6 });
  assert.equal(trades.length, before, "no new trade while the kill switch is on");
  assert.equal(trades.filter((t) => t.status === "open").length, 0, "the open trade was still closed");
  assert.ok(app.store.events({ limit: 1e6 }).some((e) => e.type === "entry_refused" && e.message.includes("kill switch")));
  await app.close();
});

test("a position the bot did not open halts it", async () => {
  const { app, fake, bot, step } = await setup();
  await step();
  assert.equal(app.store.openTrade(bot.id), null, "flat after the first bar of this window");
  fake.positions.set("BTCUSDT", { amt: 0.5, entry: 80_000 });
  await step();
  const b = app.store.getBot(bot.id);
  assert.equal(b.status, "halted");
  assert.match(b.halted_reason, /did not open/);
  await app.close();
});

test("a failed stop placement closes the position instead of leaving it unprotected", async () => {
  const { app, fake, bot, step } = await setup();
  fake.failNext.set("POST /fapi/v1/algoOrder", { code: -1000, msg: "boom", status: 400 });
  // Fail twice (the runner retries once).
  const origFetch = fake.fetch;
  let failures = 0;
  fake.fetch = async (url, init) => {
    if (new URL(url).pathname === "/fapi/v1/algoOrder" && (init?.method ?? "GET") === "POST" && failures < 2) {
      failures++;
      return { ok: false, status: 400, statusText: "400", headers: { get: () => null }, text: async () => JSON.stringify({ code: -1000, msg: "boom" }) };
    }
    return origFetch(url, init);
  };
  // The REST client captured the original fetch; swap it there.
  for (const r of app.manager.restClients.values()) r.fetch = fake.fetch;
  for (let k = 0; k < 300 && app.store.trades({ botId: bot.id }).length === 0; k++) await step();
  const t = app.store.trades({ botId: bot.id })[0];
  assert.ok(t, "an entry was attempted");
  assert.equal(t.status, "closed");
  assert.equal(t.exit_reason, "PROTECTIVE_FAILED");
  assert.equal(fake.positions.get("BTCUSDT"), undefined, "flat on the exchange");
  await app.close();
});
