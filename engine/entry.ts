// The engine surface the bot uses, bundled by scripts/sync-engine.mjs straight from bist-charts' source.
// Nothing here is reimplemented: every export is bist-charts code ("@/" resolves to its src/).
export { decideAtClose } from "@/lib/quant/live-decision";
export {
  PRESET_STRATEGY_CATALOG,
  PRESET_STRATEGY_KINDS,
  SUPPORTED_MA_TYPES,
  evaluatePresetStrategySignals,
  isPresetStrategyKind,
  isSupportedMaType,
  runPresetStrategyBacktest,
} from "@/lib/quant/strategies";
export { CRYPTO_RULES } from "@/lib/quant/market-rules";
export { buildVenueRules } from "@/lib/quant/venue-rules";
export { snapCandlesToTickGrid } from "@/lib/quant/tick-grid";
export { computeStrategyMetrics } from "@/lib/quant/metrics";
export { MAX_PERP_LEVERAGE, liquidationPrice, perpSizingCash } from "@/lib/quant/execution-core";
export { parseSymbolFilters } from "@/lib/market-cache/binance-filters";
export { pyRound } from "@/lib/quant/bist-ticks";
export { parseBacktestRequest, BacktestRefusal } from "@/lib/quant/backtest-request";
