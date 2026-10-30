// Spot account adapter (long only). The bot's position is the base asset it bought, as recorded in its open
// trade; other holdings of the same asset are never touched. The stop-loss and take-profit rest on the exchange
// as one OCO sell (TAKE_PROFIT above, STOP_LOSS below, both market on trigger), or a single order when only one
// is set.
import { BinanceError } from "../binance/rest.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SpotExchange {
  /** @param {{rest: import("../binance/rest.js").BinanceRest, baseAsset: (symbol: string) => string, quoteAsset?: string}} opts */
  constructor({ rest, baseAsset, quoteAsset = "USDT" }) {
    this.rest = rest;
    this.kind = "spot";
    this.baseAsset = baseAsset;
    this.quoteAsset = quoteAsset;
  }

  async prepare() {
    return { exchangeLeverage: 1 };
  }

  async balances() {
    const acct = await this.rest.signed("GET", "/api/v3/account", { omitZeroBalances: "true" });
    const out = new Map();
    for (const b of acct?.balances ?? []) out.set(b.asset, { free: Number(b.free), locked: Number(b.locked) });
    return out;
  }

  async availableBalance() {
    return (await this.balances()).get(this.quoteAsset)?.free ?? 0;
  }

  /**
   * Spot has no position to read: the bot holds what its open trade says while the protective orders are still
   * open (or there are none) and the asset is still on the account.
   */
  async position(symbol, trade) {
    if (!trade) return { dir: 0, qty: 0, entryPrice: null, liquidationPrice: null };
    const held = (await this.balances()).get(this.baseAsset(symbol));
    const total = held ? held.free + held.locked : 0;
    if (trade.protective?.listId || trade.protective?.orderId) {
      const done = await this.protectiveDone(symbol, trade);
      if (done) return { dir: 0, qty: 0, entryPrice: null, liquidationPrice: null };
    }
    if (total < trade.qty * 0.5) return { dir: 0, qty: 0, entryPrice: null, liquidationPrice: null };
    return { dir: 1, qty: Math.min(total, trade.qty), entryPrice: trade.entry_price, liquidationPrice: null };
  }

  async marketOrder({ symbol, side, qty, clientId }) {
    let order;
    try {
      order = await this.rest.signed("POST", "/api/v3/order", { symbol, side, type: "MARKET", quantity: qty, newClientOrderId: clientId, newOrderRespType: "FULL" });
    } catch (e) {
      if (!(e instanceof BinanceError) || !e.transient) throw e;
      order = await this.findOrder(symbol, clientId);
      if (order === null) throw e;
    }
    let fills = order.fills;
    if (!Array.isArray(fills)) fills = await this.rest.signed("GET", "/api/v3/myTrades", { symbol, orderId: order.orderId });
    let qtyFilled = 0;
    let quote = 0;
    let fee = 0;
    let baseFee = 0;
    for (const f of fills) {
      const q = Number(f.qty);
      const p = Number(f.price);
      qtyFilled += q;
      quote += q * p;
      const c = Number(f.commission);
      if (f.commissionAsset === this.quoteAsset) fee += c;
      else if (f.commissionAsset === this.baseAsset(symbol)) {
        fee += c * p;
        baseFee += c;
      } else fee += c * p; // BNB or other: valued at the fill price as an approximation.
    }
    if (!(qtyFilled > 0)) throw new Error(`Spot market order ${clientId} reported no fills`);
    return {
      orderId: String(order.orderId),
      avgPrice: quote / qtyFilled,
      qty: qtyFilled,
      // A buy that paid its fee in the base asset holds less than it bought.
      netQty: side === "BUY" ? qtyFilled - baseFee : qtyFilled,
      fee,
      time: Number(order.transactTime ?? order.updateTime ?? Date.now()),
    };
  }

  async findOrder(symbol, clientId) {
    for (let i = 0; i < 3; i++) {
      try {
        return await this.rest.signed("GET", "/api/v3/order", { symbol, origClientOrderId: clientId });
      } catch (e) {
        if (e instanceof BinanceError && e.code === -2013) return null;
        if (!(e instanceof BinanceError) || !e.transient) throw e;
        await sleep(500 * (i + 1));
      }
    }
    return null;
  }

  async placeProtective({ symbol, qty, stopLoss, takeProfit, clientPrefix }) {
    if (stopLoss !== null && takeProfit !== null) {
      const r = await this.rest.signed("POST", "/api/v3/orderList/oco", {
        symbol,
        side: "SELL",
        quantity: qty,
        aboveType: "TAKE_PROFIT",
        aboveStopPrice: takeProfit,
        belowType: "STOP_LOSS",
        belowStopPrice: stopLoss,
        listClientOrderId: `${clientPrefix}-oco`,
      });
      return { listId: String(r.orderListId) };
    }
    if (stopLoss === null && takeProfit === null) return {};
    const type = stopLoss !== null ? "STOP_LOSS" : "TAKE_PROFIT";
    const r = await this.rest.signed("POST", "/api/v3/order", {
      symbol,
      side: "SELL",
      type,
      quantity: qty,
      stopPrice: stopLoss ?? takeProfit,
      newClientOrderId: `${clientPrefix}-${stopLoss !== null ? "sl" : "tp"}`,
    });
    return { orderId: String(r.orderId) };
  }

  async cancelProtective(symbol, trade) {
    try {
      if (trade?.protective?.listId) await this.rest.signed("DELETE", "/api/v3/orderList", { symbol, orderListId: trade.protective.listId });
      else if (trade?.protective?.orderId) await this.rest.signed("DELETE", "/api/v3/order", { symbol, orderId: trade.protective.orderId });
    } catch (e) {
      // Already filled or cancelled.
      if (!(e instanceof BinanceError) || (e.code !== -2011 && e.code !== -2013)) throw e;
    }
  }

  /** True when the protective order(s) have finished, i.e. the position was sold on the exchange. */
  async protectiveDone(symbol, trade) {
    try {
      if (trade.protective.listId) {
        const l = await this.rest.signed("GET", "/api/v3/orderList", { orderListId: trade.protective.listId });
        return l.listOrderStatus === "ALL_DONE" && (l.orders ?? []).length > 0 && (await this.listFilled(symbol, l));
      }
      const o = await this.rest.signed("GET", "/api/v3/order", { symbol, orderId: trade.protective.orderId });
      return o.status === "FILLED";
    } catch {
      return false;
    }
  }

  async listFilled(symbol, list) {
    for (const o of list.orders) {
      const full = await this.rest.signed("GET", "/api/v3/order", { symbol, orderId: o.orderId });
      if (full.status === "FILLED") return true;
    }
    return false;
  }

  async exitFills(symbol, _dir, sinceMs) {
    const rows = await this.rest.signed("GET", "/api/v3/myTrades", { symbol, startTime: sinceMs, limit: 1000 });
    const sells = (Array.isArray(rows) ? rows : []).filter((f) => !f.isBuyer);
    if (sells.length === 0) return null;
    let qty = 0;
    let quote = 0;
    let fee = 0;
    let time = 0;
    for (const f of sells) {
      const q = Number(f.qty);
      const p = Number(f.price);
      qty += q;
      quote += q * p;
      const c = Number(f.commission);
      fee += f.commissionAsset === this.quoteAsset ? c : c * p;
      time = Math.max(time, Number(f.time));
    }
    return { avgPrice: quote / qty, qty, fee, time };
  }

  async firedProtective() {
    return null;
  }

  async addMargin() {}

  async fundingSince() {
    return 0;
  }
}
