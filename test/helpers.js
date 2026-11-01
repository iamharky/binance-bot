// Test doubles: a clock, timers that never fire on their own, a WebSocket that never connects, and a fake Binance
// that serves klines and exchangeInfo from the fixtures and simulates a USD-M futures account and a spot account.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const EXCHANGE_INFO = JSON.parse(readFileSync(join(ROOT, "test/fixtures/exchange-info.json"), "utf8"));

export function loadBars(name) {
  const raw = JSON.parse(readFileSync(join(ROOT, "test/fixtures", name), "utf8"));
  return raw.candles.map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

/** Funding settlements of a fixture as Binance's /fapi/v1/fundingRate rows ({fundingTime ms, fundingRate, markPrice?}). */
export function loadFunding(name) {
  const raw = JSON.parse(readFileSync(join(ROOT, "test/fixtures", name), "utf8"));
  return raw.funding.map(([ms, rate, mark]) => ({ fundingTime: ms, fundingRate: String(rate), ...(mark !== undefined ? { markPrice: String(mark) } : {}) }));
}

export class Clock {
  constructor(ms) {
    this.ms = ms;
    this.now = () => this.ms;
  }
}

export const noTimers = {
  setTimeoutImpl: () => 0,
  clearTimeoutImpl: () => {},
};

export class DeadWebSocket {
  constructor() {
    this.closed = false;
  }
  close() {
    this.closed = true;
  }
}

const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: String(status),
  headers: { get: () => null },
  text: async () => JSON.stringify(body),
});

/**
 * fake Binance. `bars` maps "BTCUSDT" -> engine bars (15m); both markets serve the same bars. `funding` maps a symbol to
 * its settlement rows (loadFunding); /fapi/v1/fundingRate serves those in [startTime, endTime] already settled.
 * The futures account: one-way positions per symbol, MARKET fills at `this.price(symbol)`, algo stop/target orders
 * that `triggerStops(symbol, bar)` fires, fees at 0.05 %; GTC LIMIT orders rest (a marketable one fills at once) until
 * `fillLimits(symbol, bar)` fills them as a bar trades there (maker 0.02 %) or DELETE cancels them.
 */
export class FakeBinance {
  constructor({ clock, bars, intervalSec = 900, balance = 100_000, funding = {} }) {
    this.clock = clock;
    this.bars = bars;
    this.funding = funding;
    this.intervalSec = intervalSec;
    this.balance = balance;
    this.positions = new Map();
    this.orders = new Map();
    this.algo = new Map();
    this.fills = [];
    this.calls = [];
    this.leverage = new Map();
    this.marginType = new Map();
    this.margin = new Map();
    this.dualSide = false;
    this.failNext = new Map();
    this.nextOrderId = 1;
    this.nextAlgoId = 1000;
    this.priceOverride = new Map();
    this.fetch = this.fetch.bind(this);
  }

  closedBars(symbol) {
    const nowSec = this.clock.ms / 1000;
    return this.bars[symbol].filter((b) => b.time + this.intervalSec <= nowSec);
  }

  /** The last price: the newest closed bar's close (the next bar's open on a 24x7 market). */
  price(symbol) {
    if (this.priceOverride.has(symbol)) return this.priceOverride.get(symbol);
    const c = this.closedBars(symbol);
    return c[c.length - 1].close;
  }

  async fetch(url, init = {}) {
    const u = new URL(url);
    const p = Object.fromEntries(u.searchParams);
    const method = init.method ?? "GET";
    const key = `${method} ${u.pathname}`;
    this.calls.push({ key, params: p, host: u.host });
    const fail = this.failNext.get(key);
    if (fail) {
      this.failNext.delete(key);
      return json({ code: fail.code, msg: fail.msg }, fail.status ?? 400);
    }
    switch (key) {
      case "GET /fapi/v1/exchangeInfo":
        return json(EXCHANGE_INFO.futures);
      case "GET /api/v3/exchangeInfo":
        return json({ symbols: EXCHANGE_INFO.spot.symbols.filter((s) => !p.symbol || s.symbol === p.symbol) });
      case "GET /fapi/v1/klines":
      case "GET /api/v3/klines": {
        const start = Number(p.startTime) / 1000;
        const limit = Number(p.limit);
        const nowSec = this.clock.ms / 1000;
        // Binance returns the forming bar too; MarketData must drop it.
        const rows = this.bars[p.symbol].filter((b) => b.time >= start && b.time <= nowSec).slice(0, limit);
        return json(rows.map((b) => [b.time * 1000, String(b.open), String(b.high), String(b.low), String(b.close), String(b.volume), (b.time + this.intervalSec) * 1000 - 1]));
      }
      case "GET /fapi/v1/fundingRate": {
        const rows = (this.funding[p.symbol] ?? []).filter(
          (f) => f.fundingTime >= Number(p.startTime ?? 0) && f.fundingTime <= Number(p.endTime ?? Infinity) && f.fundingTime <= this.clock.ms,
        );
        return json(rows.slice(0, Number(p.limit ?? 100)));
      }
      case "GET /fapi/v1/ticker/price":
      case "GET /api/v3/ticker/price":
        return json({ symbol: p.symbol, price: String(this.price(p.symbol)) });
      case "GET /fapi/v1/time":
      case "GET /api/v3/time":
        return json({ serverTime: this.clock.ms });
      case "GET /fapi/v1/positionSide/dual":
        return json({ dualSidePosition: this.dualSide });
      case "POST /fapi/v1/marginType":
        if (this.marginType.get(p.symbol) === p.marginType) return json({ code: -4046, msg: "No need to change margin type." }, 400);
        this.marginType.set(p.symbol, p.marginType);
        return json({ code: 200, msg: "success" });
      case "POST /fapi/v1/leverage":
        if (!Number.isInteger(Number(p.leverage))) return json({ code: -1111, msg: "Precision is over the maximum defined for this asset." }, 400);
        this.leverage.set(p.symbol, Number(p.leverage));
        return json({ symbol: p.symbol, leverage: Number(p.leverage) });
      case "GET /fapi/v3/positionRisk": {
        const pos = this.positions.get(p.symbol);
        return json(pos ? [{ symbol: p.symbol, positionSide: "BOTH", positionAmt: String(pos.amt), entryPrice: String(pos.entry), liquidationPrice: "0" }] : []);
      }
      case "GET /fapi/v3/balance":
        return json([{ asset: "USDT", availableBalance: String(this.balance) }]);
      case "POST /fapi/v1/order":
        return this.futuresOrder(p);
      case "GET /fapi/v1/order": {
        const o = [...this.orders.values()].find((x) => x.clientOrderId === p.origClientOrderId);
        return o ? json(o) : json({ code: -2013, msg: "Order does not exist." }, 400);
      }
      case "DELETE /fapi/v1/order": {
        const o = [...this.orders.values()].find((x) => x.clientOrderId === p.origClientOrderId);
        if (!o || o.status !== "NEW") return json({ code: -2011, msg: "Unknown order sent." }, 400);
        o.status = "CANCELED";
        o.updateTime = this.clock.ms;
        return json(o);
      }
      case "GET /fapi/v1/userTrades": {
        let rows = this.fills.filter((f) => f.symbol === p.symbol);
        if (p.orderId) rows = rows.filter((f) => String(f.orderId) === String(p.orderId));
        if (p.startTime) rows = rows.filter((f) => f.time >= Number(p.startTime));
        return json(rows);
      }
      case "POST /fapi/v1/algoOrder": {
        if (this.algo.size > 0 && [...this.algo.values()].some((a) => a.clientAlgoId === p.clientAlgoId)) return json({ code: -4116, msg: "ClientOrderId is duplicated." }, 400);
        const a = { algoId: this.nextAlgoId++, ...p, triggerPrice: Number(p.triggerPrice), algoStatus: "NEW" };
        this.algo.set(a.algoId, a);
        return json(a);
      }
      case "DELETE /fapi/v1/algoOpenOrders":
        for (const [id, a] of this.algo) if (a.symbol === p.symbol && a.algoStatus === "NEW") this.algo.delete(id);
        return json({ code: 200, msg: "The operation of cancel all open order is done." });
      case "GET /fapi/v1/algoOrder": {
        const a = this.algo.get(Number(p.algoId)) ?? this.firedAlgo?.get(Number(p.algoId));
        return a ? json(a) : json({ code: -2013, msg: "Order does not exist." }, 400);
      }
      case "POST /fapi/v1/positionMargin": {
        this.margin.set(p.symbol, (this.margin.get(p.symbol) ?? 0) + Number(p.amount));
        return json({ amount: Number(p.amount), code: 200, msg: "Successfully modify position margin.", type: 1 });
      }
      case "GET /fapi/v1/income":
        return json([]);
      default:
        return json({ code: -1, msg: `fake binance has no ${key}` }, 404);
    }
  }

  futuresOrder(p) {
    const qty = Number(p.quantity);
    const price = this.price(p.symbol);
    const dir = p.side === "BUY" ? 1 : -1;
    if (p.type === "LIMIT") {
      const limit = Number(p.price);
      const id = this.nextOrderId++;
      const o = { orderId: id, clientOrderId: p.newClientOrderId, symbol: p.symbol, type: "LIMIT", status: "NEW", price: p.price, origQty: String(qty), avgPrice: "0", executedQty: "0", updateTime: this.clock.ms, side: p.side };
      this.orders.set(id, o);
      // A price the market has already passed fills at once at the market (taker).
      if (dir === 1 ? price <= limit : price >= limit) this.fillOrder(o, price, 0.0005);
      return json(o);
    }
    const pos = this.positions.get(p.symbol) ?? { amt: 0, entry: 0 };
    if (p.reduceOnly === "true" && (pos.amt === 0 || Math.sign(pos.amt) === dir)) return json({ code: -2022, msg: "ReduceOnly Order is rejected." }, 400);
    this.fill(p.symbol, p.side, qty, price);
    const id = this.nextOrderId++;
    const o = { orderId: id, clientOrderId: p.newClientOrderId, symbol: p.symbol, status: "FILLED", avgPrice: String(price), executedQty: String(qty), updateTime: this.clock.ms, side: p.side };
    this.orders.set(id, o);
    this.fills[this.fills.length - 1].orderId = id;
    return json(o);
  }

  /** Fills resting LIMIT orders the bar trades at: at the open when it opens through them, else at their price (maker). */
  fillLimits(symbol, bar) {
    for (const o of this.orders.values()) {
      if (o.symbol !== symbol || o.type !== "LIMIT" || o.status !== "NEW") continue;
      const limit = Number(o.price);
      const buy = o.side === "BUY";
      const through = buy ? bar.open <= limit : bar.open >= limit;
      if (!through && !(buy ? bar.low <= limit : bar.high >= limit)) continue;
      this.fillOrder(o, through ? bar.open : limit, 0.0002, bar.time * 1000);
    }
  }

  fillOrder(o, price, feeRate, time = this.clock.ms) {
    this.fill(o.symbol, o.side, Number(o.origQty), price, feeRate, time);
    this.fills[this.fills.length - 1].orderId = o.orderId;
    Object.assign(o, { status: "FILLED", avgPrice: String(price), executedQty: o.origQty, updateTime: time });
  }

  fill(symbol, side, qty, price, feeRate = 0.0005, time = this.clock.ms) {
    const dir = side === "BUY" ? 1 : -1;
    const pos = this.positions.get(symbol) ?? { amt: 0, entry: 0 };
    const amt = Math.round((pos.amt + dir * qty) * 1e8) / 1e8;
    if (amt === 0) this.positions.delete(symbol);
    else this.positions.set(symbol, { amt, entry: Math.sign(amt) === Math.sign(pos.amt) && pos.amt !== 0 ? pos.entry : price });
    this.fills.push({ symbol, side, qty: String(qty), price: String(price), commission: String(qty * price * feeRate), commissionAsset: "USDT", time });
  }

  /** Fires resting algo orders a bar reaches (stop first), closing the position at the trigger price. */
  triggerStops(symbol, bar) {
    const pos = this.positions.get(symbol);
    if (!pos) return null;
    const open = [...this.algo.values()].filter((a) => a.symbol === symbol && a.algoStatus === "NEW");
    const stop = open.find((a) => a.type === "STOP_MARKET");
    const tp = open.find((a) => a.type === "TAKE_PROFIT_MARKET");
    const long = pos.amt > 0;
    let fired = null;
    if (stop && (long ? bar.low <= stop.triggerPrice : bar.high >= stop.triggerPrice)) fired = stop;
    else if (tp && (long ? bar.high >= tp.triggerPrice : bar.low <= tp.triggerPrice)) fired = tp;
    if (!fired) return null;
    this.fill(symbol, long ? "SELL" : "BUY", Math.abs(pos.amt), fired.triggerPrice);
    fired.algoStatus = "FINISHED";
    fired.actualOrderId = 999;
    this.firedAlgo = this.firedAlgo ?? new Map();
    this.firedAlgo.set(fired.algoId, fired);
    for (const [id, a] of this.algo) if (a.symbol === symbol) this.algo.delete(id);
    return fired.type;
  }
}

export function testConfig(over = {}) {
  return {
    port: 0,
    host: "127.0.0.1",
    dataDir: ":memory:",
    cookieSecure: false,
    trustProxy: false,
    liveTradingEnabled: false,
    bistChartsDir: "/nonexistent",
    keys: { demo: { apiKey: "demo-key", apiSecret: "demo-secret" }, live: { apiKey: "", apiSecret: "" } },
    telegram: { token: "", chatId: "" },
    ...over,
  };
}
