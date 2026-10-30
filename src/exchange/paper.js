// Paper account: the same calls as the real adapters, filled locally. Market orders fill at the reference price
// the runner sets (the close the decision was made on, which is the next bar's open to within a tick on a 24x7
// market) and pay the taker fee; resting stops and targets fill when a later bar reaches them, at the level (or
// at the open when the bar gaps through it), stop first when one bar reaches both.
export class PaperExchange {
  constructor({ takerFeeRate = 0.0005, now = () => Date.now() } = {}) {
    this.kind = "paper";
    this.takerFeeRate = takerFeeRate;
    this.now = now;
    this.refPrice = new Map();
    this.protective = new Map();
    this.exits = new Map();
    this.seq = 0;
  }

  setReferencePrice(symbol, price) {
    this.refPrice.set(symbol, price);
  }

  async prepare(_symbol, { leverage }) {
    return { exchangeLeverage: Math.ceil(leverage - 1e-9) };
  }

  async availableBalance() {
    return Number.POSITIVE_INFINITY;
  }

  async position(symbol, trade) {
    if (!trade || this.exits.has(`${symbol}:${trade.id}`)) return { dir: 0, qty: 0, entryPrice: null, liquidationPrice: null };
    return { dir: trade.side === "short" ? -1 : 1, qty: trade.qty, entryPrice: trade.entry_price, liquidationPrice: null };
  }

  async marketOrder({ symbol, qty }) {
    const price = this.refPrice.get(symbol);
    if (!(price > 0)) throw new Error(`No reference price for ${symbol}`);
    return { orderId: `paper-${++this.seq}`, avgPrice: price, qty, netQty: qty, fee: qty * price * this.takerFeeRate, time: this.now() };
  }

  async placeProtective({ symbol, dir, stopLoss, takeProfit, tradeId }) {
    this.protective.set(symbol, { dir, stopLoss, takeProfit, tradeId });
    return { paper: true };
  }

  async cancelProtective(symbol) {
    this.protective.delete(symbol);
  }

  /** Checks a closed bar against the resting stop and target of the symbol's open trade. */
  onBar(symbol, bar, closeMs) {
    const p = this.protective.get(symbol);
    if (!p) return null;
    const long = p.dir === 1;
    let exit = null;
    if (p.stopLoss !== null) {
      if (long ? bar.open <= p.stopLoss : bar.open >= p.stopLoss) exit = { price: bar.open, reason: "STOP_LOSS_GAP" };
      else if (long ? bar.low <= p.stopLoss : bar.high >= p.stopLoss) exit = { price: p.stopLoss, reason: "STOP_LOSS" };
    }
    if (exit === null && p.takeProfit !== null) {
      if (long ? bar.open >= p.takeProfit : bar.open <= p.takeProfit) exit = { price: bar.open, reason: "TAKE_PROFIT_GAP" };
      else if (long ? bar.high >= p.takeProfit : bar.low <= p.takeProfit) exit = { price: p.takeProfit, reason: "TAKE_PROFIT" };
    }
    if (exit === null) return null;
    this.protective.delete(symbol);
    this.exits.set(`${symbol}:${p.tradeId}`, { ...exit, time: closeMs });
    return exit;
  }

  async exitFills(symbol, _dir, _sinceMs, trade) {
    const e = trade ? this.exits.get(`${symbol}:${trade.id}`) : null;
    if (!e) return null;
    return { avgPrice: e.price, qty: trade.qty, fee: trade.qty * e.price * this.takerFeeRate, time: e.time, reason: e.reason };
  }

  async firedProtective() {
    return null;
  }

  async addMargin() {}

  async fundingSince() {
    return 0;
  }
}
