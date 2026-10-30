// Fixed strategies on the bundled fixtures. scripts/sync-engine.mjs hashes their trade lists into
// engine/golden.json; test/engine.test.js checks the committed bundle still produces them.
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Fixture file → engine bars ({time, open, high, low, close, volume}). */
export function loadFixture(root, name) {
  const raw = JSON.parse(readFileSync(join(root, "test/fixtures", name), "utf8"));
  return raw.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

/** `engine` is the bundle (engine/engine.mjs); every case trades on its CRYPTO_RULES, as the bot does. */
export function goldenCases(root, engine) {
  const btc = loadFixture(root, "btcusdt-15m.json");
  const eth = loadFixture(root, "ethusdt-15m.json");
  const base = { symbol: "BINANCE:BTCUSDT", marketRules: engine.CRYPTO_RULES, initialCapital: 10_000, commissionRate: 0.0005, takerFeeRate: 0.0005, makerFeeRate: 0.0002, finalLiquidation: true };
  const perp = (extra) => ({ positionMode: "perp", perpDirection: "both", ...extra });
  return [
    { name: "btc kama 9/21 perp both", candles: btc, strategy: perp({ kind: "ma_cross", maType: "KAMA", fast: 9, slow: 21 }), options: base },
    { name: "btc kama 84/115 perp both", candles: btc, strategy: perp({ kind: "ma_cross", maType: "KAMA", fast: 84, slow: 115 }), options: base },
    {
      name: "btc kama 9/21 perp 2.5x tp3 sl2",
      candles: btc,
      strategy: perp({ kind: "ma_cross", maType: "KAMA", fast: 9, slow: 21, takeProfitPct: 3, stopLossPct: 2 }),
      options: { ...base, leverage: 2.5, maintenanceMarginRate: 0.004 },
    },
    { name: "btc ema 20/50 spot", candles: btc, strategy: { kind: "ma_cross", maType: "EMA", fast: 20, slow: 50 }, options: base },
    { name: "btc willy spot", candles: btc, strategy: { kind: "turguts_willy" }, options: base },
    { name: "eth supertrend adx perp long", candles: eth, strategy: perp({ kind: "supertrend_adx", perpDirection: "long_only" }), options: base },
    { name: "eth donchian perp 3x hold 24", candles: eth, strategy: perp({ kind: "donchian_breakout", exitAfterBars: 24 }), options: { ...base, leverage: 3 } },
    { name: "eth ttm squeeze perp short", candles: eth, strategy: perp({ kind: "ttm_squeeze", perpDirection: "short_only" }), options: base },
  ];
}
