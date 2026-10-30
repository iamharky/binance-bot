// A paper bot driven bar by bar through 1,200 real BTCUSDT 15m bars must trade the engine's own backtest of those
// bars: every engine entry after the bot started is a bot entry on the same side, decided at the close before the
// engine's fill bar, and every exit happens at the same bar.
import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Clock, DeadWebSocket, FakeBinance, loadBars, noTimers, testConfig } from "./helpers.js";

const SEC = 900;
const bars = loadBars("btcusdt-15m.json");

async function runPaperBot({ strategy, execution, startIdx = 1800 }) {
  const clock = new Clock((bars[startIdx - 1].time + SEC) * 1000 + 3000);
  const fake = new FakeBinance({ clock, bars: { BTCUSDT: bars } });
  const app = createApp(testConfig(), { fetchImpl: fake.fetch, WebSocketImpl: DeadWebSocket, now: clock.now, quiet: true, ...noTimers });
  const bot = await app.manager.createBot({ name: "parity", account: "paper", market: "futures", symbol: "BTCUSDT", timeframe: "15m", warmupBars: 1000, strategy, execution });
  await app.manager.startBot(bot.id);
  const runner = app.manager.runners.get(bot.id);
  for (let i = startIdx; i < bars.length; i++) {
    clock.ms = (bars[i].time + SEC) * 1000 + 3000;
    await app.feed.catchUp("futures:BTCUSDT:15m");
    await runner.queue;
  }
  const live = app.store.trades({ botId: bot.id, limit: 1e6 }).reverse();
  const run = runner.backtestSinceAnchor();
  const firstFill = bars[startIdx + 1].time;
  // Engine round trips whose entry the bot could take (decided at a close it processed).
  const engine = [];
  let open = null;
  for (const t of run.trades) {
    if (t.type === "ENTRY") open = t;
    else if (open) {
      if (open.time >= firstFill) engine.push({ side: open.side, entry: open.time, entryPrice: open.price, exit: t.time, reason: t.reason });
      open = null;
    }
  }
  if (open && open.time >= firstFill) engine.push({ side: open.side, entry: open.time, entryPrice: open.price, exit: null, reason: null });
  const events = app.store.events({ limit: 1e6 });
  await app.close();
  return { live, engine, events };
}

test("signal-only strategy: the paper bot's trades are the engine's, bar for bar", async () => {
  const { live, engine, events } = await runPaperBot({
    strategy: { kind: "ma_cross", maType: "KAMA", fast: 9, slow: 21, perpDirection: "both" },
    execution: { capital: 10_000, takerFeePercent: 0.05, makerFeePercent: 0.02, leverage: 1 },
  });
  assert.ok(engine.length > 20, `engine traded ${engine.length} round trips`);
  assert.equal(events.filter((e) => e.level === "error").length, 0, JSON.stringify(events.filter((e) => e.level === "error").slice(0, 3)));
  assert.equal(live.length, engine.length, "same number of trades");
  for (let k = 0; k < engine.length; k++) {
    const e = engine[k];
    const l = live[k];
    assert.equal(l.side, e.side, `trade ${k} side`);
    assert.equal(l.engine_bar_time + SEC, e.entry, `trade ${k} entry bar`);
    if (e.exit === null) assert.equal(l.status, "open", `trade ${k} still open`);
    else {
      // The engine fills the exit at bar e.exit's open; the bot exits at the close just before it (+3 s of settling).
      assert.equal(l.exit_time, e.exit * 1000 + 3000, `trade ${k} exit time`);
      assert.equal(l.exit_reason, e.reason, `trade ${k} exit reason`);
    }
    // Paper fills at the decision close; the engine at the next open. On Binance klines they are the same price
    // or a tick apart.
    assert.ok(Math.abs(l.entry_price - e.entryPrice) / e.entryPrice < 0.002, `trade ${k} entry ${l.entry_price} vs engine ${e.entryPrice}`);
  }
});

test("2.5x with stop and target: entries and exit reasons follow the engine", async () => {
  const { live, engine } = await runPaperBot({
    strategy: { kind: "ma_cross", maType: "KAMA", fast: 9, slow: 21, perpDirection: "both", takeProfitPct: 1.5, stopLossPct: 0.8 },
    execution: { capital: 10_000, takerFeePercent: 0.05, makerFeePercent: 0.02, leverage: 2.5, maintenanceMarginPercent: 0.4 },
  });
  assert.ok(engine.length > 20, `engine traded ${engine.length} round trips`);
  const byEntry = new Map(engine.map((e) => [e.entry, e]));
  let matched = 0;
  let sameExit = 0;
  for (const l of live) {
    const e = byEntry.get(l.engine_bar_time + SEC);
    if (!e || e.side !== l.side) continue;
    matched++;
    if (e.exit === null ? l.status === "open" : l.exit_reason?.replace("_GAP", "") === e.reason.replace("_GAP", "")) sameExit++;
  }
  // Paper fills at the close and the engine at the next open, so a level can sit a tick apart; nearly all agree.
  assert.ok(matched / engine.length >= 0.97, `matched ${matched} of ${engine.length} engine trades`);
  assert.ok(sameExit / matched >= 0.95, `same exit reason on ${sameExit} of ${matched}`);
});
