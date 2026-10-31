// The PYTHUSDT preset (src/presets.js) and the engine's volatility sizing and limit entries in a bot:
// - the preset carries every rule of the strategy and makes a valid bot; a warm-up shorter than the volatility
//   window and limit entries on spot are refused;
// - paper: the preset's rules on faster periods (so the 2,800-bar fixture trades often) make the engine's trades,
//   entry type, entry bar, price and size included;
// - futures: limit entries on a simulated account rest at the engine's price, fill when a bar trades there and get
//   the stop on the exchange, expire into a market entry, and a stopped bot cancels the order it was working.
import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { parseLabSettings } from "../src/engine.js";
import { BOT_PRESETS } from "../src/presets.js";
import { Clock, DeadWebSocket, FakeBinance, loadBars, noTimers, testConfig } from "./helpers.js";

const SEC = 900;
const bars = loadBars("pythusdt-15m.json");
const PRESET = BOT_PRESETS.find((p) => p.id === "pythusdt-15m-ema-drift");
/** The preset's rules on faster periods: 6 / 7.5 h averages, a 4 h hold, 3-day volatility, a 2-hour early-turn window. */
const fast = (entryLimit) => ({
  ...PRESET.settings.strategy,
  fast: 24,
  slow: 30,
  exitAfterBars: 16,
  stopLossPct: 5,
  volLookbackDays: 3,
  earlyTurn: { ...PRESET.settings.strategy.earlyTurn, lookbackBars: 8 },
  entryLimit,
});
const WARMUP = 800;
const START = 900;

async function setup(account, strategy) {
  const clock = new Clock((bars[START - 1].time + SEC) * 1000 + 3000);
  const fake = new FakeBinance({ clock, bars: { PYTHUSDT: bars } });
  const app = createApp(testConfig(), { fetchImpl: fake.fetch, WebSocketImpl: DeadWebSocket, now: clock.now, quiet: true, ...noTimers });
  const bot = await app.manager.createBot({ ...PRESET.settings, name: `pyth ${account}`, account, warmupBars: WARMUP, strategy, execution: { ...PRESET.settings.execution, capital: 10_000 } });
  await app.manager.startBot(bot.id);
  const runner = app.manager.runners.get(bot.id);
  let i = START;
  /** Plays the next bar: the exchange fills resting limits and fires stops inside it, then it closes and the bot decides. */
  const step = async () => {
    fake.fillLimits("PYTHUSDT", bars[i]);
    fake.triggerStops("PYTHUSDT", bars[i]);
    clock.ms = (bars[i].time + SEC) * 1000 + 3000;
    await app.feed.catchUp("futures:PYTHUSDT:15m");
    await runner.queue;
    i++;
  };
  return { app, fake, clock, bot, runner, step, index: () => i };
}

/** The engine's round trips whose entry the bot could make: signalled at or after its first close. */
function engineTrades(app, runner) {
  const bot = app.store.getBot(runner.id);
  const candles = app.store.candles("futures", "PYTHUSDT", "15m", bot.anchor_time);
  const run = runner.backtestSinceAnchor();
  const first = bars[START].time;
  const signalOf = (t) => {
    if (t.reason === "LIMIT_ENTRY") return candles[run.limitOrders.find((o) => o.outcome === "filled" && candles[o.endBar].time === t.time).signalBar].time;
    if (t.reason === "LIMIT_FALLBACK") return candles[run.limitOrders.find((o) => o.outcome === "expired" && candles[o.endBar + 1]?.time === t.time).signalBar].time;
    return t.time - SEC;
  };
  const out = [];
  let open = null;
  for (const t of run.trades) {
    if (t.type === "ENTRY") open = signalOf(t) >= first ? t : null;
    else if (open) {
      out.push({ side: open.side, entry: open.time, entryPrice: open.price, reason: open.reason, size: open.size, exit: t.time, exitReason: t.reason });
      open = null;
    }
  }
  if (open) out.push({ side: open.side, entry: open.time, entryPrice: open.price, reason: open.reason, size: open.size, exit: null, exitReason: null });
  return out;
}

test("the PYTHUSDT preset carries every rule of the strategy and makes a valid bot", async () => {
  assert.ok(PRESET, "the preset is listed");
  const s = PRESET.settings;
  assert.deepEqual([s.market, s.symbol, s.timeframe, s.account], ["futures", "PYTHUSDT", "15m", "paper"]);
  assert.deepEqual(s.strategy, {
    kind: "ma_cross", maType: "EMA", fast: 240, slow: 300, perpDirection: "both", exitOnSignal: true, exitAfterBars: 168, stopLossPct: 20,
    volTargetPct: 3, volLookbackDays: 14, volCapPct: 12,
    earlyTurn: { lookbackBars: 96, earlyMax: 0.043, lateMin: 0.102, earlyMult: 1.5, lateMult: 0.5 },
    entryLimit: { offsetPct: 0, waitBars: 2, fallback: "market" },
  });
  assert.equal(s.execution.leverage, 1);
  const lab = parseLabSettings(s);
  for (const [k, v] of Object.entries(s.strategy)) assert.deepEqual(lab.strategy[k], v, `bist-charts' parser keeps ${k}`);
  assert.equal(lab.execution.takerFeeRate, 0.0005);
  assert.equal(lab.execution.makerFeeRate, 0.0002);

  const clock = new Clock((bars[2000].time + SEC) * 1000 + 3000);
  const fake = new FakeBinance({ clock, bars: { PYTHUSDT: bars } });
  const app = createApp(testConfig(), { fetchImpl: fake.fetch, WebSocketImpl: DeadWebSocket, now: clock.now, quiet: true, ...noTimers });
  const bot = await app.manager.createBot(s);
  for (const [k, v] of Object.entries(s.strategy)) assert.deepEqual(bot.strategy[k], v, `the stored bot keeps ${k}`);
  assert.equal(bot.warmup_bars, 3000);
  await assert.rejects(app.manager.createBot({ ...s, name: "short warm-up", warmupBars: 1000 }), /warmupBars must cover the 16 days/);
  const { perpDirection: _d, ...spotStrategy } = s.strategy;
  await assert.rejects(app.manager.createBot({ ...s, name: "spot", market: "spot", symbol: "BTCUSDT", strategy: spotStrategy }), /Limit entries trade on futures bots only/);
  await app.close();
});

test("paper: volatility sizing and limit entries make the engine's trades, bar for bar", async () => {
  const { app, bot, runner, step } = await setup("paper", fast({ offsetPct: 0.3, waitBars: 2, fallback: "market" }));
  for (let k = START; k < bars.length; k++) await step();
  const live = app.store.trades({ botId: bot.id, limit: 1e6 }).reverse();
  const engine = engineTrades(app, runner);
  const errors = app.store.events({ limit: 1e6 }).filter((e) => e.level === "error");
  assert.deepEqual(errors, []);
  assert.ok(engine.length > 15, `engine traded ${engine.length} round trips`);
  assert.ok(engine.some((e) => e.reason === "LIMIT_ENTRY") && engine.some((e) => e.reason === "LIMIT_FALLBACK"), "both entry kinds occur");
  assert.ok(engine.some((e) => e.size < 1), "volatility sizing below all-in occurs");
  assert.equal(live.length, engine.length, "same number of trades");
  let realized = 0;
  for (let k = 0; k < engine.length; k++) {
    const e = engine[k];
    const l = live[k];
    assert.equal(l.side, e.side, `trade ${k} side`);
    assert.equal(l.entry_reason, e.reason, `trade ${k} entry kind`);
    if (e.reason === "LIMIT_ENTRY") {
      assert.equal(l.entry_time, e.entry * 1000, `trade ${k} fills on the engine's bar`);
      assert.equal(l.entry_price, e.entryPrice, `trade ${k} fills at the engine's price`);
    } else {
      assert.equal(l.engine_bar_time + SEC, e.entry, `trade ${k} enters at the engine's open`);
      assert.ok(Math.abs(l.entry_price - e.entryPrice) / e.entryPrice < 0.003, `trade ${k} entry ${l.entry_price} vs engine ${e.entryPrice}`);
    }
    // Sized as the engine sizes it: the notional over the bot's wallet is the engine's share (to a lot and a fee).
    const wallet = 10_000 + realized;
    const share = (l.qty * l.entry_price) / wallet;
    assert.ok(Math.abs(share - Math.min(1, e.size)) < 0.01, `trade ${k} share ${share} vs engine size ${e.size}`);
    if (e.exit === null) assert.equal(l.status, "open", `trade ${k} still open`);
    else {
      assert.equal(l.exit_reason, e.exitReason, `trade ${k} exit reason`);
      realized += l.pnl;
    }
  }
  await app.close();
});

test("futures: limit entries rest at the engine's price, fill with the stop on, and fall back to market", async () => {
  const { app, fake, bot, step } = await setup("demo", fast({ offsetPct: 0.5, waitBars: 2, fallback: "market" }));
  for (let k = START; k < bars.length; k++) await step();
  const errors = app.store.events({ limit: 1e6 }).filter((e) => e.level === "error");
  assert.deepEqual(errors, []);
  assert.equal(app.store.getBot(bot.id).status, "running");
  const orders = app.store.orders({ botId: bot.id, limit: 1e6 });
  const limits = orders.filter((o) => o.purpose === "entry_limit");
  assert.ok(limits.length > 10, `${limits.length} limit orders`);
  // Each limit went to the exchange as a GTC LIMIT at the price of the decision that placed it.
  const sent = fake.calls.filter((c) => c.key === "POST /fapi/v1/order" && c.params.type === "LIMIT");
  assert.equal(sent.length, limits.length);
  for (const c of sent) assert.equal(c.params.timeInForce, "GTC");
  const decisions = app.store.decisions(bot.id, 1e6);
  const actionPrices = new Set(decisions.flatMap((d) => d.actions.filter((a) => a.at === "limit").map((a) => a.limitPrice)));
  for (const o of limits) assert.ok(actionPrices.has(o.price), `limit ${o.price} is an engine price`);
  const trades = app.store.trades({ botId: bot.id, limit: 1e6 });
  const filled = trades.filter((t) => t.entry_reason === "LIMIT_ENTRY");
  const fallbacks = trades.filter((t) => t.entry_reason === "LIMIT_FALLBACK");
  assert.ok(filled.length > 5, `${filled.length} limit fills`);
  assert.ok(fallbacks.length > 0, `${fallbacks.length} market fallbacks`);
  assert.ok(limits.some((o) => o.status === "cancelled"), "expired limits are cancelled on the exchange");
  for (const t of filled) assert.ok(t.protective?.stopLoss, `limit-filled trade ${t.id} has its stop on the exchange`);
  // Fees: a limit fill pays the maker rate.
  for (const t of filled) assert.ok(Math.abs(t.entry_fee - t.qty * t.entry_price * 0.0002) < 1e-6, `trade ${t.id} maker fee`);
  await app.close();
});

test("a stopped bot cancels the limit entry it was working; a manual open waits for it", async () => {
  const { app, fake, bot, step } = await setup("demo", fast({ offsetPct: 0.5, waitBars: 2, fallback: "market" }));
  for (let k = START; k < bars.length && !app.store.getBot(bot.id).working_entry; k++) await step();
  const w = app.store.getBot(bot.id).working_entry;
  assert.ok(w, "a limit entry is working");
  await assert.rejects(app.manager.manualOpen(bot.id, "long", {}), /limit entry/);
  await app.manager.stopBot(bot.id);
  assert.equal(app.store.getBot(bot.id).working_entry, null);
  const order = [...fake.orders.values()].find((o) => o.clientOrderId === w.clientId);
  assert.equal(order.status, "CANCELED");
  await app.close();
});
