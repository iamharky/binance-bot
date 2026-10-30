// The committed engine bundle and the settings parser.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { ConfigError, engine, ENGINE_INFO, parseLabSettings, protectiveLevels, venueRules } from "../src/engine.js";
import { goldenCases } from "../src/golden-cases.js";
import { EXCHANGE_INFO, ROOT } from "./helpers.js";

test("the bundle is the one engine.json describes", () => {
  const bundle = readFileSync(join(ROOT, "engine/engine.mjs"));
  assert.equal(createHash("sha256").update(bundle).digest("hex"), ENGINE_INFO.bundleSha256);
  assert.ok(ENGINE_INFO.inputs.includes("src/lib/quant/live-decision.ts"));
  assert.ok(ENGINE_INFO.inputs.includes("src/lib/quant/execution-core.ts"));
});

test("the bundle still trades the golden strategies exactly as at sync time", () => {
  const golden = JSON.parse(readFileSync(join(ROOT, "engine/golden.json"), "utf8"));
  assert.equal(golden.commit, ENGINE_INFO.commit);
  for (const c of goldenCases(ROOT, engine)) {
    const run = engine.runPresetStrategyBacktest(c.candles, c.strategy, c.options);
    const sha = createHash("sha256").update(JSON.stringify(run.trades)).digest("hex");
    assert.equal(sha, golden.cases[c.name].sha256, c.name);
  }
});

const futures = (strategy, execution = {}) => ({ market: "futures", symbol: "BTCUSDT", timeframe: "15m", strategy, execution: { capital: 1000, takerFeePercent: 0.05, ...execution } });

test("bot settings parse with bist-charts' own rules", () => {
  const lab = parseLabSettings(futures({ kind: "ma_cross", maType: "KAMA", fast: 84, slow: 115, perpDirection: "both" }, { leverage: 2.5, maintenanceMarginPercent: 0.4, makerFeePercent: 0.02 }));
  assert.equal(lab.strategy.positionMode, "perp");
  assert.equal(lab.execution.leverage, 2.5);
  assert.equal(lab.execution.maintenanceMarginRate, 0.004);
  assert.equal(lab.execution.takerFeeRate, 0.0005);
  assert.equal(lab.execution.makerFeeRate, 0.0002);
  assert.equal(lab.request.symbol, "BINANCE:BTCUSDT");
  const spot = parseLabSettings({ market: "spot", symbol: "ETHUSDT", timeframe: "1H", strategy: { kind: "turguts_willy" }, execution: { capital: 500, takerFeePercent: 0.1 } });
  assert.equal(spot.request.symbol, "CRYPTO:ETHUSDT");
  assert.equal(spot.execution.positionMode, "spot");
});

test("out-of-domain settings are refused, never clamped", () => {
  const refuses = (input, re) => assert.throws(() => parseLabSettings(input), (e) => e instanceof ConfigError && re.test(e.message));
  refuses(futures({ kind: "ma_cross", fast: 30, slow: 20 }), /Fast period must be less than slow/);
  refuses(futures({ kind: "ma_cross", fast: 9, slow: 21 }, { leverage: 200 }), /Leverage/);
  refuses(futures({ kind: "ma_cross", fast: 9, slow: 21, stopLossPct: 120 }), /stop/i);
  refuses(futures({ kind: "nope" }), /Unknown strategy/);
  refuses(futures({ kind: "buy_hold" }), /spot only/);
  refuses({ ...futures({ kind: "ma_cross" }), timeframe: "1M" }, /Timeframe/);
  refuses({ ...futures({ kind: "ma_cross" }), symbol: "btc-usdt" }, /Symbol/);
  refuses({ ...futures({ kind: "ma_cross" }), execution: { capital: 0 } }, /Capital/);
  refuses({ market: "spot", symbol: "BTCUSDT", timeframe: "15m", strategy: { kind: "ma_cross", positionMode: "perp" }, execution: { capital: 100 } }, /Spot bots/);
});

test("stop and target trigger where the engine's touch rule does, on the exchange tick", () => {
  const { rules } = venueRules("futures", EXCHANGE_INFO.futures.symbols.find((s) => s.symbol === "BTCUSDT"));
  const lab = parseLabSettings(futures({ kind: "ma_cross", fast: 9, slow: 21, perpDirection: "both", takeProfitPct: 1.5, stopLossPct: 0.8 }));
  // 100,000.05 entry: long stop 99,200.0496 -> floor 99,200.0; long target 101,500.05075 -> ceil 101,500.1.
  assert.deepEqual(protectiveLevels(lab, rules, "long", 100_000.05), { takeProfit: 101_500.1, stopLoss: 99_200 });
  // Short: target 98,500.04925 -> floor 98,500.0; stop 100,800.0504 -> ceil 100,800.1.
  assert.deepEqual(protectiveLevels(lab, rules, "short", 100_000.05), { takeProfit: 98_500, stopLoss: 100_800.1 });
  const none = parseLabSettings(futures({ kind: "ma_cross", fast: 9, slow: 21 }));
  assert.deepEqual(protectiveLevels(none, rules, "long", 100_000), { takeProfit: null, stopLoss: null });
});
