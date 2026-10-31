// Ready-made bots: a strategy the bist-charts research settled on, with every setting it was validated with.
// GET /api/meta lists them and the New bot form's Preset menu fills the whole form from one; the owner still
// chooses the account (paper by default) and the capital, then saves. A preset is plain bot settings: it goes
// through the same validation as a hand-made bot (bist-charts' parser included).
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
      execution: { capital: 1000, leverage: 1, takerFeePercent: 0.05, makerFeePercent: 0.02, maintenanceMarginPercent: 0, marginType: "ISOLATED" },
      risk: { maxDailyLossPct: null, maxDrawdownPct: null, maxConsecutiveFailures: 5, flattenOnHalt: false },
    },
  },
];
