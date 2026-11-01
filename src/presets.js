// Ready-made bots: a strategy the bist-charts research settled on, with every setting it was validated with.
// GET /api/meta lists them and the New bot form's Preset menu fills the whole form from one; the owner still
// chooses the account (paper by default) and the capital, then saves. A preset is plain bot settings: it goes
// through the same validation as a hand-made bot (bist-charts' parser included).
//
// The BTCUSDT presets are bist-charts research/btc-perp's strategies (BTC-RAPOR.md in Turkish, README.md study 43 and
// study 45, where the engine makes the studies' trades: the daily rules trade for trade with market orders, F1 trade
// for trade as specified; the studies rested their exits as limits, the engine exits at market, which cost the
// momentum book 783 -> 742 % over 2020-2026).

/** Money and risk shared by the presets: paper, 1x, Binance's USD-M fees, isolated margin. */
const EXECUTION = { capital: 1000, leverage: 1, takerFeePercent: 0.05, makerFeePercent: 0.02, maintenanceMarginPercent: 0, marginType: "ISOLATED" };
const RISK = { maxDailyLossPct: null, maxDrawdownPct: null, maxConsecutiveFailures: 5, flattenOnHalt: false };
const btc = (name, timeframe, warmupBars, strategy) => ({
  name,
  account: "paper",
  market: "futures",
  symbol: "BTCUSDT",
  timeframe,
  warmupBars,
  strategy: { exitOnSignal: true, ...strategy },
  execution: EXECUTION,
  risk: RISK,
});
const TREND_GROUP =
  "The trend group is F1, F2 and F17, each a third of one account: 2020-2026 +1,056 % (drawdown 38 %) against BTC held " +
  "+984 % (drawdown 77 %), chosen on 2024-2026, so the evidence is after the fact; forward-tested from 2026-10-30. " +
  "Run the three side by side with a third of the capital each: paper bots may share a symbol; on demo or live each " +
  "needs its own account, since Binance nets one position per symbol.";

export const BOT_PRESETS = [
  {
    id: "pythusdt-15m-ema-drift",
    name: "PYTHUSDT 15m: EMA 60/75 h drift",
    source: "bist-charts research/pyth-ma-crossover/PYTH-15M-STRATEGY.md (in Turkish: PYTH-15M-STRATEJI.md)",
    description:
      "Long when EMA 240 crosses above EMA 300 on 15m bars, short when it crosses below. Out after 42 h (168 bars) " +
      "or at the opposite crossing (which reverses), 20 % catastrophe stop, no take-profit. Size: 3 % a day over the " +
      "14-day mean daily range (at most the whole capital, 1x), 1.5x for an early crossing and 0.5x for a late one; " +
      "no signal while that range is 12 % or more. Entry: a limit at the signal close for 2 bars (30 min), then market. " +
      "Warm-up 3,000 bars (31 days) so the averages and the 14-day range are settled.",
    settings: {
      name: "PYTH 15m EMA drift",
      account: "paper",
      market: "futures",
      symbol: "PYTHUSDT",
      timeframe: "15m",
      warmupBars: 3000,
      strategy: {
        kind: "ma_cross",
        maType: "EMA",
        fast: 240,
        slow: 300,
        perpDirection: "both",
        exitOnSignal: true,
        exitAfterBars: 168,
        stopLossPct: 20,
        volTargetPct: 3,
        volLookbackDays: 14,
        volCapPct: 12,
        earlyTurn: { lookbackBars: 96, earlyMax: 0.043, lateMin: 0.102, earlyMult: 1.5, lateMult: 0.5 },
        entryLimit: { offsetPct: 0, waitBars: 2, fallback: "market" },
      },
      execution: EXECUTION,
      risk: RISK,
    },
  },
  {
    id: "btcusdt-1d-momentum-14d",
    name: "BTCUSDT 1D: 14-day momentum (long)",
    source: "bist-charts research/btc-perp/BTC-RAPOR.md (study 43b; engine parity: README.md study 45)",
    description:
      "Long while BTC's last 14 days rose by at least a quarter of their usual swing (the 14-day log return over the " +
      "30-day daily volatility times sqrt(14) is 0.25 or more), flat otherwise; decided at each daily close (00:00 UTC). " +
      "Size: 2 % a day over the 30-day daily volatility (at most the capital, 1x), times the brake (the median 30-day " +
      "volatility so far over today's, at most 1). Entry: a limit at the close for one day, then market; exits at " +
      "market. Warm-up 2,600 days, BTC's perpetual history since 2019, so the brake's median is the study's. Study: " +
      "2020-2023 (unseen when chosen) +275 %, 2020-2026 +783 % (drawdown 38 %), walk-forward 2022-2026 +134 %.",
    settings: btc("BTC 1D 14-day momentum", "1D", 2600, {
      kind: "tsmom",
      lookbackDays: 14,
      thresholdZ: 0.25,
      perpDirection: "long_only",
      volTargetPct: 2,
      volLookbackDays: 30,
      volMeasure: "stdev",
      volBrake: true,
      entryLimit: { offsetPct: 0, waitBars: 1, fallback: "market" },
    }),
  },
  {
    id: "btcusdt-1d-low-funding",
    name: "BTCUSDT 1D: buy when funding is low (long)",
    source: "bist-charts research/btc-perp/BTC-RAPOR.md (study 43d; engine parity: README.md study 45)",
    description:
      "Long while the day's funding (its settlements summed) is among the lowest 20 % of the last 180 days (shorts " +
      "crowded), flat otherwise; decided at each daily close on the settlements up to it. All in (the capital, 1x). " +
      "Entry: a limit at the close for one day, placed again at each close while the rule holds (no market chase); " +
      "exits at market. Warm-up 400 days. Study: 2020-2023 (unseen when chosen) +317 %, 2020-2026 +702 % (drawdown " +
      "23 %), walk-forward 2022-2026 +87 %.",
    settings: btc("BTC 1D low funding", "1D", 400, {
      kind: "funding_dip",
      fundingDays: 1,
      rankDays: 180,
      bandPct: 20,
      perpDirection: "long_only",
      entryLimit: { offsetPct: 0, waitBars: 1, fallback: "skip" },
    }),
  },
  {
    id: "btcusdt-15m-trend-f1",
    name: "BTCUSDT 15m: trend group F1, EMA 90/270 h",
    source: "bist-charts research/btc-perp/BTC-RAPOR.md (the trend group; engine parity: README.md study 45)",
    description:
      "Long when EMA 360 crosses above EMA 1080 on 15m bars (90 h / 270 h), short when it crosses below; always in " +
      "(the opposite crossing reverses), 20 % stop. Size 3 % a day over the 14-day mean daily range (at most 1x); no " +
      "signal while that range is 12 % or more. Entry: a limit at the signal close for 2 bars (30 min), then market. " +
      "Warm-up 10,000 bars (104 days). " +
      TREND_GROUP,
    settings: btc("BTC trend F1 EMA 90/270 h", "15m", 10_000, {
      kind: "ma_cross",
      maType: "EMA",
      fast: 360,
      slow: 1080,
      perpDirection: "both",
      stopLossPct: 20,
      volTargetPct: 3,
      volLookbackDays: 14,
      volCapPct: 12,
      entryLimit: { offsetPct: 0, waitBars: 2, fallback: "market" },
    }),
  },
  {
    id: "btcusdt-1d-trend-f2",
    name: "BTCUSDT 1D: trend group F2, 14-day rise (long)",
    source: "bist-charts research/btc-perp/BTC-RAPOR.md (the trend group; engine parity: README.md study 45)",
    description:
      "Long while the last 14 days' return is positive, flat otherwise; decided at each daily close. Size 3 % a day " +
      "over the 30-day daily volatility (at most 1x). Entry: a limit at the close for one day, then market; exits at " +
      "market. Warm-up 400 days. " +
      TREND_GROUP,
    settings: btc("BTC trend F2 14-day rise", "1D", 400, {
      kind: "tsmom",
      lookbackDays: 14,
      thresholdZ: 0,
      perpDirection: "long_only",
      volTargetPct: 3,
      volLookbackDays: 30,
      volMeasure: "stdev",
      entryLimit: { offsetPct: 0, waitBars: 1, fallback: "market" },
    }),
  },
  {
    id: "btcusdt-1d-trend-f17",
    name: "BTCUSDT 1D: trend group F17, above the 50-day average (long)",
    source: "bist-charts research/btc-perp/BTC-RAPOR.md (the trend group; engine parity: README.md study 45)",
    description:
      "Long while the daily close is above the average of the last 50 daily closes, flat below; decided at each daily " +
      "close. Size 3 % a day over the 30-day daily volatility (at most 1x). Market entries and exits. Warm-up 400 days. " +
      TREND_GROUP,
    settings: btc("BTC trend F17 above 50-day average", "1D", 400, {
      kind: "sma_filter",
      lookbackDays: 50,
      perpDirection: "long_only",
      volTargetPct: 3,
      volLookbackDays: 30,
      volMeasure: "stdev",
    }),
  },
];
