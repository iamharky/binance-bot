// USD-M futures account adapter (one-way mode, isolated or cross margin). Entries and exits are MARKET orders;
// the stop-loss and take-profit rest on the exchange as conditional algo orders (STOP_MARKET /
// TAKE_PROFIT_MARKET, closePosition=true), so a bot that is down never leaves a position without them. Binance
// moved conditional orders off /fapi/v1/order to /fapi/v1/algoOrder (error -4120 on the old endpoint).
//
// Decimal leverage: Binance takes whole numbers only. The exchange is set to ceil(L), the bot sizes the position
// at L, and in isolated mode tops the position margin up to notional / L right after the fill, so margin, risk
// and the liquidation price all follow L.
import { BinanceError } from "../binance/rest.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FuturesExchange {
  /** @param {{rest: import("../binance/rest.js").BinanceRest, quoteAsset?: string}} opts */
  constructor({ rest, quoteAsset = "USDT" }) {
    this.rest = rest;
    this.kind = "futures";
    this.quoteAsset = quoteAsset;
  }

  async prepare(symbol, { leverage, marginType = "ISOLATED" }) {
    const mode = await this.rest.signed("GET", "/fapi/v1/positionSide/dual");
    if (mode?.dualSidePosition) throw new Error("The futures account is in Hedge Mode; switch it to One-way Mode (the bot nets one position per symbol)");
    try {
      await this.rest.signed("POST", "/fapi/v1/marginType", { symbol, marginType });
    } catch (e) {
      // -4046: already that margin type. -4048: cannot change while a position or order is open.
      if (!(e instanceof BinanceError) || (e.code !== -4046 && e.code !== -4048)) throw e;
    }
    const exchangeLeverage = Math.ceil(leverage - 1e-9);
    await this.rest.signed("POST", "/fapi/v1/leverage", { symbol, leverage: exchangeLeverage });
    return { exchangeLeverage };
  }

  /** The symbol's net position: dir 1 / -1 / 0, absolute qty, entry price. */
  async position(symbol) {
    const rows = await this.rest.signed("GET", "/fapi/v3/positionRisk", { symbol });
    const row = (Array.isArray(rows) ? rows : []).find((r) => r.symbol === symbol && (r.positionSide ?? "BOTH") === "BOTH");
    const amt = row ? Number(row.positionAmt) : 0;
    if (!amt) return { dir: 0, qty: 0, entryPrice: null, liquidationPrice: null };
    return { dir: amt > 0 ? 1 : -1, qty: Math.abs(amt), entryPrice: Number(row.entryPrice), liquidationPrice: Number(row.liquidationPrice) || null };
  }

  async availableBalance() {
    const rows = await this.rest.signed("GET", "/fapi/v3/balance");
    const row = (Array.isArray(rows) ? rows : []).find((r) => r.asset === this.quoteAsset);
    return row ? Number(row.availableBalance) : 0;
  }

  /**
   * MARKET order; returns the fill {orderId, avgPrice, qty, fee, time}. When the request's outcome is unknown
   * (network error, timeout, 5xx) the order is looked up by its client id before anything is retried.
   */
  async marketOrder({ symbol, side, qty, reduceOnly = false, clientId }) {
    const params = { symbol, side, type: "MARKET", quantity: qty, newClientOrderId: clientId, newOrderRespType: "RESULT", ...(reduceOnly ? { reduceOnly: "true" } : {}) };
    let order;
    try {
      order = await this.rest.signed("POST", "/fapi/v1/order", params);
    } catch (e) {
      if (!(e instanceof BinanceError) || !e.transient) throw e;
      order = await this.findOrder(symbol, clientId);
      if (order === null) throw e;
    }
    if (order.status !== "FILLED") order = await this.waitFilled(symbol, clientId);
    const fills = await this.rest.signed("GET", "/fapi/v1/userTrades", { symbol, orderId: order.orderId });
    let fee = 0;
    for (const f of Array.isArray(fills) ? fills : []) {
      const c = Number(f.commission);
      fee += f.commissionAsset === this.quoteAsset ? c : c * Number(f.price);
    }
    return {
      orderId: String(order.orderId),
      avgPrice: Number(order.avgPrice),
      qty: Number(order.executedQty),
      fee,
      time: Number(order.updateTime ?? order.transactTime ?? Date.now()),
    };
  }

  async findOrder(symbol, clientId) {
    for (let i = 0; i < 3; i++) {
      try {
        return await this.rest.signed("GET", "/fapi/v1/order", { symbol, origClientOrderId: clientId });
      } catch (e) {
        if (e instanceof BinanceError && e.code === -2013) return null;
        if (!(e instanceof BinanceError) || !e.transient) throw e;
        await sleep(500 * (i + 1));
      }
    }
    return null;
  }

  async waitFilled(symbol, clientId) {
    for (let i = 0; i < 10; i++) {
      const o = await this.rest.signed("GET", "/fapi/v1/order", { symbol, origClientOrderId: clientId });
      if (o.status === "FILLED") return o;
      if (o.status === "CANCELED" || o.status === "EXPIRED" || o.status === "REJECTED") throw new Error(`Market order ${clientId} ended ${o.status}`);
      await sleep(300);
    }
    throw new Error(`Market order ${clientId} not filled after 3 s`);
  }

  /** Conditional exits for the open position; returns the algo ids. */
  async placeProtective({ symbol, dir, stopLoss, takeProfit, workingType = "CONTRACT_PRICE", clientPrefix }) {
    const side = dir === 1 ? "SELL" : "BUY";
    const ids = {};
    const place = async (type, triggerPrice, tag) => {
      const r = await this.rest.signed("POST", "/fapi/v1/algoOrder", {
        algoType: "CONDITIONAL",
        symbol,
        side,
        type,
        triggerPrice,
        closePosition: "true",
        workingType,
        priceProtect: "false",
        clientAlgoId: `${clientPrefix}-${tag}`,
      });
      return String(r.algoId);
    };
    if (stopLoss !== null) ids.stopLoss = await place("STOP_MARKET", stopLoss, "sl");
    if (takeProfit !== null) ids.takeProfit = await place("TAKE_PROFIT_MARKET", takeProfit, "tp");
    return ids;
  }

  async cancelProtective(symbol) {
    try {
      await this.rest.signed("DELETE", "/fapi/v1/algoOpenOrders", { symbol });
    } catch (e) {
      // Nothing open is not an error here.
      if (!(e instanceof BinanceError) || (e.code !== -2011 && e.code !== -2013)) throw e;
    }
  }

  /** Isolated margin top-up so the position's margin is notional / leverage (decimal leverage). */
  async addMargin(symbol, amount) {
    if (!(amount > 0)) return;
    await this.rest.signed("POST", "/fapi/v1/positionMargin", { symbol, amount: amount.toFixed(4), type: 1 });
  }

  /**
   * What closed a position the bot did not close itself: the account's fills since `sinceMs` on the closing
   * side, summed (avg price, qty, fee, realized P&L, last fill time).
   */
  async exitFills(symbol, dir, sinceMs) {
    const rows = await this.rest.signed("GET", "/fapi/v1/userTrades", { symbol, startTime: sinceMs, limit: 1000 });
    const closing = (Array.isArray(rows) ? rows : []).filter((f) => (dir === 1 ? f.side === "SELL" : f.side === "BUY"));
    if (closing.length === 0) return null;
    let qty = 0;
    let quote = 0;
    let fee = 0;
    let time = 0;
    for (const f of closing) {
      const q = Number(f.qty);
      qty += q;
      quote += q * Number(f.price);
      const c = Number(f.commission);
      fee += f.commissionAsset === this.quoteAsset ? c : c * Number(f.price);
      time = Math.max(time, Number(f.time));
    }
    return { avgPrice: quote / qty, qty, fee, time };
  }

  /** Which conditional order fired, from the open algo orders left (the other one is cancelled with the position). */
  async firedProtective(symbol, ids) {
    for (const [tag, algoId] of Object.entries(ids ?? {})) {
      try {
        const o = await this.rest.signed("GET", "/fapi/v1/algoOrder", { algoId });
        if (o.algoStatus === "TRIGGERED" || o.algoStatus === "FINISHED" || o.actualOrderId) return tag === "stopLoss" ? "STOP_LOSS" : "TAKE_PROFIT";
      } catch {
        // Unknown: the caller falls back to a generic reason.
      }
    }
    return null;
  }

  /** Funding paid (negative) or received (positive) on the symbol since `sinceMs`. */
  async fundingSince(symbol, sinceMs) {
    const rows = await this.rest.signed("GET", "/fapi/v1/income", { symbol, incomeType: "FUNDING_FEE", startTime: sinceMs, limit: 1000 });
    return (Array.isArray(rows) ? rows : []).reduce((s, r) => s + Number(r.income), 0);
  }
}
