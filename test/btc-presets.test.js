// The BTCUSDT presets (src/presets.js; bist-charts research/btc-perp) and the engine's daily rules in a bot:
// - each preset carries its study's rules, survives bist-charts' parser and makes a valid bot; a warm-up shorter than
//   a daily rule reads and a daily rule on 15m bars are refused;
// - paper: each daily preset fed 1,398 real BTCUSDT days (2023-2026) one close at a time makes the engine's trades:
//   side, entry kind, entry day and price, size, exit day and reason (the momentum book's brake and the funding rule's
//   day limits included, the funding read from settlements Binance stamps milliseconds after the second);
// - paper bots of the trend group share the symbol, a second demo bot on it is refused;
// - the funding download keeps the settlement at the window's end although its time is a few milliseconds late.
import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { MarketData } from "../src/binance/market.js";
import { roundToTick } from "../src/bot/runner.js";
import { parseLabSettings } from "../src/engine.js";
import { BOT_PRESETS } from "../src/presets.js";
import { Clock, DeadWebSocket, FakeBinance, loadBars, loadFunding, noTimers, testConfig } from "./helpers.js";

const DAY = 86_400;
const bars = loadBars("btcusdt-1d.json");
// The fixture's settlements end before its last close; the one at that close (Binance's rate of the day) is added, so
// the funding rule finds the settlement at every close it decides on.
const funding = [...loadFunding("btcusdt-funding.json"), { fundingTime: (1_793_232_000 + 86_400) * 1000 + 6, fundingRate: "0.0001" }];
const preset = (id) => BOT_PRESETS.find((p) => p.id === id);
const WARMUP = 500;
const START = 600;

test("the BTCUSDT presets carry the studies' rules and make valid bots", async () => {
  const expected = {
    "btcusdt-1d-momentum-14d": ["1D", 2600, { kind: "tsmom", lookbackDays: 14, thresholdZ: 0.25, perpDirection: "long_only", exitOnSignal: true, volTargetPct: 2, volLookbackDays: 30, volMeasure: "stdev", volBrake: true, entryLimit: { offsetPct: 0, waitBars: 1, fallback: "market" } }],
    "btcusdt-1d-low-funding": ["1D", 400, { kind: "funding_dip", fundingDays: 1, rankDays: 180, bandPct: 20, perpDirection: "long_only", exitOnSignal: true, entryLimit: { offsetPct: 0, waitBars: 1, fallback: "skip" } }],
    "btcusdt-15m-trend-f1": ["15m", 10_000, { kind: "ma_cross", maType: "EMA", fast: 360, slow: 1080, perpDirection: "both", exitOnSignal: true, stopLossPct: 20, volTargetPct: 3, volLookbackDays: 14, volCapPct: 12, entryLimit: { offsetPct: 0, waitBars: 2, fallback: "market" } }],
    "btcusdt-1d-trend-f2": ["1D", 400, { kind: "tsmom", lookbackDays: 14, thresholdZ: 0, perpDirection: "long_only", exitOnSignal: true, volTargetPct: 3, volLookbackDays: 30, volMeasure: "stdev", entryLimit: { offsetPct: 0, waitBars: 1, fallback: "market" } }],
    "btcusdt-1d-trend-f17": ["1D", 400, { kind: "sma_filter", lookbackDays: 50, perpDirection: "long_only", exitOnSignal: true, volTargetPct: 3, volLookbackDays: 30, volMeasure: "stdev" }],
  };
  const clock = new Clock((bars[bars.length - 1].time + DAY) * 1000 + 3000);
  const fake = new FakeBinance({ clock, bars: { BTCUSDT: bars }, intervalSec: DAY, funding: { BTCUSDT: funding } });
  const app = createApp(testConfig(), { fetchImpl: fake.fetch, WebSocketImpl: DeadWebSocket, now: clock.now, quiet: true, ...noTimers });
  for (const [id, [timeframe, warmupBars, strategy]] of Object.entries(expected)) {
    const p = preset(id);
    assert.ok(p, `${id} is listed`);
    const s = p.settings;
    assert.deepEqual([s.market, s.symbol, s.timeframe, s.account, s.warmupBars], ["futures", "BTCUSDT", timeframe, "paper", warmupBars], id);
    assert.deepEqual(s.strategy, strategy, `${id} strategy`);
    assert.equal(s.execution.leverage, 1);
    const lab = parseLabSettings(s);
    for (const [k, v] of Object.entries(s.strategy)) assert.deepEqual(lab.strategy[k], v, `${id}: bist-charts' parser keeps ${k}`);
    const bot = await app.manager.createBot(s);
    for (const [k, v] of Object.entries(s.strategy)) assert.deepEqual(bot.strategy[k], v, `${id}: the stored bot keeps ${k}`);
  }
  const low = preset("btcusdt-1d-low-funding").settings;
  await assert.rejects(app.manager.createBot({ ...low, name: "short warm-up", warmupBars: 150 }), /warmupBars must cover the 182 days funding_dip reads/);
  await assert.rejects(app.manager.createBot({ ...low, name: "15m", timeframe: "15m", warmupBars: 20_000 }), /daily rule decides at each daily close: run it on 1D bars/);
  await app.close();
});

/** A paper bot of a preset from START, with WARMUP days of history; `step` plays one daily close. */
async function setup(id, account = "paper") {
  const p = preset(id);
  const clock = new Clock((bars[START - 1].time + DAY) * 1000 + 3000);
  const fake = new FakeBinance({ clock, bars: { BTCUSDT: bars }, intervalSec: DAY, funding: { BTCUSDT: funding } });
  const app = createApp(testConfig(), { fetchImpl: fake.fetch, WebSocketImpl: DeadWebSocket, now: clock.now, quiet: true, ...noTimers });
  const bot = await app.manager.createBot({ ...p.settings, name: `${id} ${account}`, account, warmupBars: WARMUP, execution: { ...p.settings.execution, capital: 10_000 } });
  await app.manager.startBot(bot.id);
  const runner = app.manager.runners.get(bot.id);
  let i = START;
  const step = async () => {
    clock.ms = (bars[i].time + DAY) * 1000 + 3000;
    await app.feed.catchUp("futures:BTCUSDT:1D");
    await runner.queue;
    i++;
  };
  return { app, fake, bot, runner, step };
}

/** The engine's round trips whose entry the bot could make: signalled at or after its first close. */
function engineTrades(app, runner) {
  const bot = app.store.getBot(runner.id);
  const candles = app.store.candles("futures", "BTCUSDT", "1D", bot.anchor_time);
  const run = runner.backtestSinceAnchor();
  const first = bars[START].time;
  const signalOf = (t) => {
    if (t.reason === "LIMIT_ENTRY") return candles[run.limitOrders.find((o) => o.outcome === "filled" && candles[o.endBar].time === t.time).signalBar].time;
    if (t.reason === "LIMIT_FALLBACK") return candles[run.limitOrders.find((o) => o.outcome === "expired" && candles[o.endBar + 1]?.time === t.time).signalBar].time;
    return t.time - DAY;
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

// A limit at a daily close rests a whole day: BTC trades back through it nearly every day, so its market fallback is
// allowed but rare (none in this window).
for (const [id, minTrades, kinds] of [
  ["btcusdt-1d-momentum-14d", 10, ["LIMIT_ENTRY", "LIMIT_FALLBACK"]],
  ["btcusdt-1d-trend-f2", 15, ["LIMIT_ENTRY", "LIMIT_FALLBACK"]],
  ["btcusdt-1d-trend-f17", 8, ["SIGNAL_ENTRY"]],
  ["btcusdt-1d-low-funding", 10, ["LIMIT_ENTRY"]],
]) {
  test(`paper: ${id} makes the engine's trades, day for day`, async () => {
    const { app, bot, runner, step } = await setup(id);
    for (let k = START; k < bars.length; k++) await step();
    const live = app.store.trades({ botId: bot.id, limit: 1e6 }).reverse();
    const engine = engineTrades(app, runner);
    const errors = app.store.events({ limit: 1e6 }).filter((e) => e.level === "error" || e.type === "funding_close_missing");
    assert.deepEqual(errors, []);
    assert.ok(engine.length >= minTrades, `engine traded ${engine.length} round trips`);
    assert.ok(engine.some((e) => e.reason === kinds[0]), `the engine enters by ${kinds[0]}`);
    assert.ok(engine.every((e) => kinds.includes(e.reason)), `entries are ${kinds.join(" / ")} only`);
    assert.equal(live.length, engine.length, "same number of trades");
    let realized = 0;
    for (let k = 0; k < engine.length; k++) {
      const e = engine[k];
      const l = live[k];
      assert.equal(l.side, e.side, `trade ${k} side`);
      assert.equal(l.entry_reason, e.reason, `trade ${k} entry kind`);
      if (e.reason === "LIMIT_ENTRY") {
        assert.equal(l.entry_time, e.entry * 1000, `trade ${k} fills on the engine's day`);
        assert.equal(l.entry_price, e.entryPrice, `trade ${k} fills at the engine's price`);
      } else {
        assert.equal(l.engine_bar_time + DAY, e.entry, `trade ${k} enters at the engine's open`);
      }
      const wallet = 10_000 + realized;
      const share = (l.qty * l.entry_price) / wallet;
      assert.ok(Math.abs(share - Math.min(1, e.size ?? 1)) < 0.03, `trade ${k} share ${share} vs engine size ${e.size}`);
      if (e.exit === null) assert.equal(l.status, "open", `trade ${k} still open`);
      else {
        assert.equal(l.exit_reason, e.exitReason, `trade ${k} exit reason`);
        assert.ok(Math.abs(l.exit_time - e.exit * 1000) <= 60_000, `trade ${k} exits at the engine's open (${l.exit_time} vs ${e.exit * 1000})`);
        realized += l.pnl;
      }
    }
    await app.close();
  });
}

test("demo: the momentum preset's day limits reach Binance on the 0.10 tick and fill", async () => {
  const { app, fake, bot, step } = await setup("btcusdt-1d-momentum-14d", "demo");
  for (let k = START; k < bars.length; k++) {
    fake.fillLimits("BTCUSDT", bars[k]);
    await step();
  }
  const errors = app.store.events({ limit: 1e6 }).filter((e) => e.level === "error");
  assert.deepEqual(errors, []);
  assert.equal(app.store.getBot(bot.id).status, "running");
  const sent = fake.calls.filter((c) => c.key === "POST /fapi/v1/order" && c.params.type === "LIMIT");
  assert.ok(sent.length > 5, `${sent.length} limit orders`);
  for (const c of sent) assert.match(c.params.price, /^\d+(\.\d)?$/, `limit price ${c.params.price} is on the tick`);
  const trades = app.store.trades({ botId: bot.id, limit: 1e6 });
  assert.ok(trades.filter((t) => t.entry_reason === "LIMIT_ENTRY").length > 5, "limit entries fill");
  await app.close();
});

test("paper bots of the trend group share BTCUSDT; a second demo bot on it is refused", async () => {
  const clock = new Clock((bars[START - 1].time + DAY) * 1000 + 3000);
  const fake = new FakeBinance({ clock, bars: { BTCUSDT: bars }, intervalSec: DAY, funding: { BTCUSDT: funding } });
  const app = createApp(testConfig(), { fetchImpl: fake.fetch, WebSocketImpl: DeadWebSocket, now: clock.now, quiet: true, ...noTimers });
  const ids = [];
  for (const id of ["btcusdt-1d-trend-f2", "btcusdt-1d-trend-f17", "btcusdt-1d-momentum-14d"]) {
    const p = preset(id);
    const bot = await app.manager.createBot({ ...p.settings, warmupBars: WARMUP, execution: { ...p.settings.execution, capital: 333 } });
    await app.manager.startBot(bot.id);
    ids.push(bot.id);
  }
  assert.deepEqual(ids.map((id) => app.store.getBot(id).status), ["running", "running", "running"]);
  const p = preset("btcusdt-1d-trend-f2");
  const a = await app.manager.createBot({ ...p.settings, name: "demo a", account: "demo", warmupBars: WARMUP });
  const b = await app.manager.createBot({ ...p.settings, name: "demo b", account: "demo", warmupBars: WARMUP });
  await app.manager.startBot(a.id);
  await assert.rejects(app.manager.startBot(b.id), /demo a already trades BTCUSDT on the demo futures account/);
  await app.close();
});

test("limit prices on BTC's 0.10 tick carry no binary noise (Binance refuses a price past the tick)", () => {
  assert.equal(roundToTick(85120.93, "0.10"), 85120.9);
  assert.equal(roundToTick(0.1234567, "0.0000100"), 0.12346);
  assert.equal(roundToTick(0.12345678, 1e-7), 0.1234568);
  let noisy = 0;
  for (let k = 0; k < 20_000; k++) if ((String(roundToTick(60_000 + k * 1.37 + 0.0123, "0.10")).split(".")[1] ?? "").length > 1) noisy++;
  assert.equal(noisy, 0);
});

test("the funding download keeps the settlement at the window's end although Binance stamps it milliseconds late", async () => {
  const close = 1_793_232_000 + DAY; // the fixture's last day's close, 2026-10-30 00:00 UTC, settled at +6 ms (above)
  assert.ok(funding.some((f) => f.fundingTime === close * 1000 + 6));
  const clock = new Clock((close + 60) * 1000);
  const fake = new FakeBinance({ clock, bars: { BTCUSDT: bars }, intervalSec: DAY, funding: { BTCUSDT: funding } });
  const market = new MarketData({ fetch: fake.fetch, now: clock.now });
  const events = await market.funding("BTCUSDT", close - 3 * DAY, close);
  assert.equal(events[events.length - 1].time, close, "the settlement at the close is in");
  assert.ok(events.every((e) => e.time <= close), "nothing after the window");
  assert.equal(events.length, 10, "three days of three settlements and the one at the close");
});
