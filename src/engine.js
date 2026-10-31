// The bot's only door to the strategy engine (engine/engine.mjs, bundled from bist-charts by
// scripts/sync-engine.mjs). Bot settings are parsed by bist-charts' own backtest-request parser, and runs pass
// the engine exactly the options bist-charts' /api/backtest passes (backtest-service.ts runParsedRequest), so a
// bot replays the Strategy Lab run its settings describe.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as engine from "../engine/engine.mjs";
import { ROOT } from "./config.js";

export { engine };

// The engine's instrument registry falls back to bist-charts' market cache for ids outside its catalogs (PYTHUSDT is
// one). The bot has no such cache: an empty in-memory one makes those lookups find nothing, so the id's shape decides
// (BINANCE: is a USD-M perpetual, CRYPTO: Binance spot) instead of the engine refusing to open a cache file.
process.env.BIST_MARKET_CACHE_DB ??= ":memory:";

export const ENGINE_INFO = JSON.parse(readFileSync(join(ROOT, "engine/engine.json"), "utf8"));

/** Timeframes the bot trades: bist-charts id -> Binance kline interval and bar length in seconds. */
export const TIMEFRAMES = {
  "1m": { binance: "1m", sec: 60 },
  "3m": { binance: "3m", sec: 180 },
  "5m": { binance: "5m", sec: 300 },
  "15m": { binance: "15m", sec: 900 },
  "30m": { binance: "30m", sec: 1800 },
  "1H": { binance: "1h", sec: 3600 },
  "2H": { binance: "2h", sec: 7200 },
  "4H": { binance: "4h", sec: 14_400 },
  "6H": { binance: "6h", sec: 21_600 },
  "8H": { binance: "8h", sec: 28_800 },
  "12H": { binance: "12h", sec: 43_200 },
  "1D": { binance: "1d", sec: 86_400 },
  "3D": { binance: "3d", sec: 259_200 },
  "1W": { binance: "1w", sec: 604_800 },
};

export class ConfigError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = "ConfigError";
    this.field = field;
  }
}

/** The bist-charts instrument id whose candles the Lab backtested: USD-M perpetual or spot. */
export function labSymbol(market, symbol) {
  return market === "futures" ? `BINANCE:${symbol}` : `CRYPTO:${symbol}`;
}

/**
 * Builds the Strategy Lab request a bot's settings stand for and parses it with bist-charts' parser
 * (refusals keep the Lab's messages). Returns {strategy, execution, initialCapital, request}.
 */
export function parseLabSettings({ market, symbol, timeframe, strategy, execution }) {
  if (market !== "spot" && market !== "futures") throw new ConfigError("Market must be spot or futures", "market");
  if (!/^[A-Z0-9]{2,20}$/.test(symbol ?? "")) throw new ConfigError("Symbol must be a Binance symbol such as BTCUSDT", "symbol");
  if (!TIMEFRAMES[timeframe]) throw new ConfigError(`Timeframe must be one of ${Object.keys(TIMEFRAMES).join(", ")}`, "timeframe");
  if (typeof strategy !== "object" || strategy === null) throw new ConfigError("Strategy is required", "strategy");
  const ex = execution ?? {};
  const perp = market === "futures";
  if (!perp && strategy.positionMode === "perp") throw new ConfigError("Spot bots trade long-only spot; use a futures bot for Long & Short", "strategy");
  if (perp && strategy.kind === "buy_hold") throw new ConfigError("Buy & hold runs spot only", "strategy.kind");
  const body = {
    symbol: labSymbol(market, symbol),
    timeframe,
    strategy: { ...strategy, positionMode: perp ? "perp" : "spot" },
    initialCapital: ex.capital,
    commissionPercent: ex.takerFeePercent,
    finalLiquidation: false,
    ...(ex.slippage ? { slippage: ex.slippage } : {}),
    ...(perp
      ? {
          leverage: ex.leverage ?? 1,
          maintenanceMarginPercent: ex.maintenanceMarginPercent ?? 0,
          takerFeePercent: ex.takerFeePercent,
          makerFeePercent: ex.makerFeePercent,
        }
      : {}),
  };
  if (!(typeof ex.capital === "number" && ex.capital > 0)) throw new ConfigError("Capital must be a positive number (USDT)", "execution.capital");
  let parsed;
  try {
    parsed = engine.parseBacktestRequest(body);
  } catch (e) {
    throw new ConfigError(e.message, e.messageKey ?? null);
  }
  return { strategy: parsed.strategy, execution: parsed.execution, initialCapital: parsed.initialCapital, request: parsed.snapshot };
}

/** Venue rules (exchange tick, lot step, minimum notional) from an exchangeInfo symbol entry. */
export function venueRules(market, exchangeInfoSymbol) {
  const m = market === "futures" ? "perp" : "spot";
  const row = engine.parseSymbolFilters(m, exchangeInfoSymbol);
  if (row === null) throw new Error(`exchangeInfo has no usable PRICE_FILTER / LOT_SIZE for ${exchangeInfoSymbol?.symbol}`);
  const filters = { symbol: row.symbol, market: m, tickSize: row.tick_size, stepSize: row.step_size, minQty: row.min_qty, minNotional: row.min_notional };
  return { filters, rules: engine.buildVenueRules(engine.CRYPTO_RULES, filters) };
}

/** The options bist-charts' backtest service passes a preset run, for a parsed bot. */
export function runOptions(lab, rules, symbol, { funding = null, finalLiquidation = false } = {}) {
  const ex = lab.execution;
  return {
    initialCapital: lab.initialCapital,
    commissionRate: ex.takerFeeRate,
    takerFeeRate: ex.takerFeeRate,
    makerFeeRate: ex.makerFeeRate,
    ...(ex.slippage !== null ? { slippageSpec: ex.slippage } : {}),
    leverage: ex.leverage,
    maintenanceMarginRate: ex.maintenanceMarginRate,
    funding,
    dividends: null,
    limitGates: null,
    symbol,
    finalLiquidation,
    marketRules: rules,
    ...(ex.participation !== null ? { participation: ex.participation } : {}),
    ...(ex.rearm === "fresh" ? { rearm: "fresh" } : {}),
  };
}

/** Candles snapped onto the venue's tick grid, as /api/backtest does before any engine run. */
export function snap(candles, rules) {
  return engine.snapCandlesToTickGrid(candles, rules).candles;
}

/** The engine's decision at the close of the newest candle. */
export function decide(lab, rules, symbol, candles, intervalSec, funding = null) {
  return engine.decideAtClose(snap(candles, rules), lab.strategy, runOptions(lab, rules, symbol, { funding }), intervalSec);
}

/** A full ledger run over candles (the backtest a bot is compared against). */
export function backtest(lab, rules, symbol, candles, { funding = null, finalLiquidation = false } = {}) {
  return engine.runPresetStrategyBacktest(snap(candles, rules), lab.strategy, runOptions(lab, rules, symbol, { funding, finalLiquidation }));
}

/** The take-profit and stop-loss trigger prices the engine uses for a fill, rounded the way the engine triggers. */
export function protectiveLevels(lab, rules, side, fill) {
  const s = lab.strategy;
  const long = side === "long";
  const tp = s.takeProfitPct ?? null;
  const sl = s.stopLossPct ?? null;
  // The engine triggers on a touch of the raw level by on-grid prices: a sell trigger (long stop, short target)
  // fires at the level floored to the tick, a buy trigger (long target, short stop) at the level ceiled.
  const takeProfit = tp === null ? null : rules.roundTick(fill * (long ? 1 + tp / 100 : 1 - tp / 100), long ? "ceil" : "floor");
  const stopLoss = sl === null ? null : rules.roundTick(fill * (long ? 1 - sl / 100 : 1 + sl / 100), long ? "floor" : "ceil");
  return { takeProfit, stopLoss };
}

/**
 * The engine's size for a fill (execution-core openAt): spot spends `sizeFraction` of the wallet, a perp sizes margin
 * + entry fee to that share at the leverage; `sizeFraction` is the decision's (volatility sizing, else 1 = all-in).
 * `fraction` (< 1) keeps a buffer for the live fill price moving and only binds when it is below `sizeFraction`.
 * `feeRate`: the fee the fill pays (the maker rate for a limit entry), else the taker rate.
 */
export function entryQty(lab, rules, wallet, price, fraction = 1, sizeFraction = 1, feeRate = null) {
  const ex = lab.execution;
  const share = Math.min(fraction, sizeFraction >= 1 ? 1 : sizeFraction);
  const cash = Math.max(0, wallet * share);
  const fee = feeRate ?? ex.takerFeeRate;
  if (ex.positionMode === "spot") return rules.calculateLotSize(cash, price, fee);
  return rules.calculateLotSize(engine.perpSizingCash(cash, ex.leverage, fee), price, fee);
}
