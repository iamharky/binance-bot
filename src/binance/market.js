// Public market data: klines, exchangeInfo filters and funding history. Decisions always read the LIVE
// exchange's market data (the data the Strategy Lab backtested), whichever account a bot trades on.
import { BinanceRest } from "./rest.js";

const KLINES_PATH = { spot: "/api/v3/klines", futures: "/fapi/v1/klines" };
const KLINE_LIMIT = { spot: 1000, futures: 1500 };

/** One kline array -> an engine bar (time in epoch seconds of the bar open). */
export function klineToBar(k) {
  return { time: Math.floor(Number(k[0]) / 1000), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) };
}

export class MarketData {
  constructor({ fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), env = "live" } = {}) {
    this.now = now;
    this.rest = {
      spot: new BinanceRest({ market: "spot", env, fetch: fetchImpl, now }),
      futures: new BinanceRest({ market: "futures", env, fetch: fetchImpl, now }),
    };
    this.exchangeInfoCache = new Map();
  }

  /**
   * Closed bars with open time in [fromSec, toSec], paged. A bar is closed when its close time has passed
   * (the forming bar is never returned).
   */
  async closedKlines(market, symbol, interval, intervalSec, fromSec, toSec = Math.floor(this.now() / 1000)) {
    const out = [];
    const limit = KLINE_LIMIT[market];
    let start = fromSec;
    const nowSec = this.now() / 1000;
    for (let guard = 0; guard < 1000 && start <= toSec; guard++) {
      const rows = await this.rest[market].publicGet(KLINES_PATH[market], { symbol, interval, startTime: start * 1000, limit });
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const k of rows) {
        const bar = klineToBar(k);
        if (bar.time > toSec) break;
        if (bar.time + intervalSec > nowSec) continue;
        if (out.length === 0 || bar.time > out[out.length - 1].time) out.push(bar);
      }
      const lastOpen = Math.floor(Number(rows[rows.length - 1][0]) / 1000);
      if (rows.length < limit || lastOpen + intervalSec > nowSec) break;
      start = lastOpen + intervalSec;
    }
    return out;
  }

  /** The exchangeInfo entry of one symbol (cached for 6 h). */
  async symbolInfo(market, symbol) {
    const key = `${market}:${symbol}`;
    const hit = this.exchangeInfoCache.get(key);
    if (hit && this.now() - hit.at < 6 * 3600 * 1000) return hit.entry;
    const path = market === "spot" ? "/api/v3/exchangeInfo" : "/fapi/v1/exchangeInfo";
    const info = await this.rest[market].publicGet(path, market === "spot" ? { symbol } : {});
    const entry = (info?.symbols ?? []).find((s) => s.symbol === symbol) ?? null;
    if (entry === null) throw new Error(`${symbol} is not listed on Binance ${market}`);
    if (entry.status !== "TRADING") throw new Error(`${symbol} on Binance ${market} is ${entry.status}, not TRADING`);
    this.exchangeInfoCache.set(key, { at: this.now(), entry });
    return entry;
  }

  /** USD-M funding settlements in [fromSec, toSec] as engine events {time (s), rate, markPrice?}. */
  async funding(symbol, fromSec, toSec) {
    const out = [];
    let start = fromSec * 1000;
    for (let guard = 0; guard < 200; guard++) {
      const rows = await this.rest.futures.publicGet("/fapi/v1/fundingRate", { symbol, startTime: start, endTime: toSec * 1000, limit: 1000 });
      if (!Array.isArray(rows) || rows.length === 0) break;
      for (const r of rows) {
        const ms = Number(r.fundingTime);
        const rate = Number(r.fundingRate);
        const mark = Number(r.markPrice);
        if (!Number.isFinite(ms) || !Number.isFinite(rate)) continue;
        const ev = { time: Math.floor(ms / 1000), rate };
        if (Number.isFinite(mark) && mark > 0) ev.markPrice = mark;
        if (out.length === 0 || ev.time > out[out.length - 1].time) out.push(ev);
      }
      if (rows.length < 1000) break;
      start = Number(rows[rows.length - 1].fundingTime) + 1;
    }
    return out;
  }

  /** Last traded price. */
  async price(market, symbol) {
    const path = market === "spot" ? "/api/v3/ticker/price" : "/fapi/v1/ticker/price";
    const r = await this.rest[market].publicGet(path, { symbol });
    return Number(r.price);
  }
}
