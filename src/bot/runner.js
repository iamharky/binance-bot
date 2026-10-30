// One bot: at every closed bar it asks the engine what the strategy does at this close (decideAtClose over the
// bars since the bot's anchor) and makes the account match.
//
// Rules, in order, on each closed bar:
// 1. Reconcile: a position the exchange closed (stop, target, liquidation) closes the bot's trade at the
//    exchange's fills; a position the bot did not open, or one on the wrong side, halts the bot.
// 2. Act on the decision's actions in ledger order: an EXIT closes the bot's position on that side; an ENTRY
//    opens one when the bot is flat and entries are allowed (kill switch, halt). Both trade now, at market: the
//    engine fills them at the next bar's open, which a 24x7 market prints right after this close.
// 3. Follow the engine when they differ: the engine flat (its stop or target hit this bar, but the exchange's
//    did not) or on the other side closes the bot's position. The bot never opens a position the engine
//    entered earlier (after downtime, a refused entry or a manual close): it waits for the next entry.
// Manual trades are the owner's: the engine's exits and rule 3 leave them alone.
// Stop and target are placed on the exchange right after every fill, at the engine's levels from the real fill.
import { backtest, decide, ENGINE_INFO, entryQty, labSymbol, parseLabSettings, protectiveLevels, TIMEFRAMES } from "../engine.js";

const sign = (side) => (side === "short" ? -1 : 1);
const sideOf = (dir) => (dir === -1 ? "short" : "long");

export class BotRunner {
  /**
   * @param {{bot: object, store: import("../db.js").Store, events: import("../events.js").EventLog,
   *          risk: import("./risk.js").RiskGuard, exchange: object, market: import("../binance/market.js").MarketData,
   *          feed: object, venue: {filters: object, rules: object}, now?: () => number}} deps
   */
  constructor({ bot, store, events, risk, exchange, market, feed, venue, now = () => Date.now() }) {
    this.store = store;
    this.events = events;
    this.risk = risk;
    this.exchange = exchange;
    this.market = market;
    this.feed = feed;
    this.venue = venue;
    this.now = now;
    this.queue = Promise.resolve();
    this.funding = null;
    this.fundingFetchedAt = 0;
    this.load(bot);
  }

  load(bot) {
    this.bot = bot;
    this.lab = parseLabSettings(bot);
    this.tf = TIMEFRAMES[bot.timeframe];
    this.labSymbol = labSymbol(bot.market, bot.symbol);
  }

  refresh() {
    this.load(this.store.getBot(this.bot.id));
    return this.bot;
  }

  get id() {
    return this.bot.id;
  }

  /** Runs `fn` after everything queued before it: one bar or manual action at a time per bot. */
  enqueue(fn) {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    return run;
  }

  log(level, type, message, data = null) {
    return this.events.emit(level, type, message, { botId: this.bot.id, data });
  }

  /** Prepares the account, fixes the replay anchor, loads history. Status becomes running. */
  start() {
    return this.enqueue(async () => {
      const bot = this.refresh();
      const sec = this.tf.sec;
      const lastClosed = Math.floor(this.now() / 1000 / sec) * sec - sec;
      const anchor = bot.anchor_time ?? lastClosed - bot.warmup_bars * sec;
      const prep = await this.exchange.prepare(bot.symbol, {
        leverage: this.lab.execution.leverage,
        marginType: bot.execution.marginType === "CROSSED" ? "CROSSED" : "ISOLATED",
      });
      await this.feed.ensureHistory(bot.market, bot.symbol, bot.timeframe, anchor);
      const open = this.store.openTrade(bot.id);
      if (open && this.exchange.kind === "paper") {
        await this.exchange.placeProtective({ symbol: bot.symbol, dir: sign(open.side), stopLoss: open.stop_price, takeProfit: open.take_profit_price, tradeId: open.id });
      }
      this.store.updateBot(bot.id, {
        status: "running",
        halted_reason: null,
        anchor_time: anchor,
        started_at: bot.started_at ?? this.now(),
        last_bar_time: bot.last_bar_time ?? lastClosed,
        engine_commit: ENGINE_INFO.commit,
      });
      this.refresh();
      this.log("info", "bot_started", `${bot.name} started on ${bot.account} ${bot.market} ${bot.symbol} ${bot.timeframe}`, {
        anchorTime: anchor,
        exchangeLeverage: prep?.exchangeLeverage ?? 1,
        leverage: this.lab.execution.leverage,
      });
    });
  }

  stop({ flatten = false } = {}) {
    return this.enqueue(async () => {
      if (flatten) await this.closePosition("MANUAL_STOP", { manual: true });
      this.store.updateBot(this.bot.id, { status: "stopped" });
      this.refresh();
      this.log("info", "bot_stopped", `${this.bot.name} stopped${flatten ? " and flattened" : ""}`);
    });
  }

  halt(reason) {
    this.store.updateBot(this.bot.id, { status: "halted", halted_reason: reason });
    this.refresh();
    this.log("warn", "bot_halted", `${this.bot.name} halted: ${reason}`);
  }

  async fundingEvents(barTime) {
    if (this.bot.market !== "futures") return null;
    if (this.funding !== null && this.now() - this.fundingFetchedAt < 3600 * 1000) return this.funding;
    try {
      this.funding = await this.market.funding(this.bot.symbol, this.bot.anchor_time, barTime + this.tf.sec);
      this.fundingFetchedAt = this.now();
    } catch (e) {
      this.log("warn", "funding_unavailable", `Funding history unavailable, the replay runs with what it has: ${e.message}`);
    }
    return this.funding;
  }

  /** A closed bar arrived for this bot's market, symbol and timeframe. */
  onBar(barTime) {
    return this.enqueue(async () => {
      const bot = this.refresh();
      if (bot.status !== "running" && bot.status !== "halted") return;
      if (bot.last_bar_time !== null && barTime <= bot.last_bar_time) return;
      const sec = this.tf.sec;
      const candles = this.store.candles(bot.market, bot.symbol, bot.timeframe, bot.anchor_time, barTime);
      const expected = (barTime - bot.anchor_time) / sec + 1;
      if (candles.length === 0 || candles[candles.length - 1].time !== barTime || candles.length !== expected) {
        this.log("warn", "history_gap", `Skipped the ${new Date(barTime * 1000).toISOString()} close: ${candles.length} of ${expected} bars stored`);
        return;
      }
      const bar = candles[candles.length - 1];
      const closeMs = (barTime + sec) * 1000;
      if (this.exchange.kind === "paper") {
        this.exchange.onBar(bot.symbol, bar, closeMs);
        this.exchange.setReferencePrice(bot.symbol, bar.close);
      }
      const d = decide(this.lab, this.venue.rules, this.labSymbol, candles, sec, await this.fundingEvents(barTime));
      this.store.insertDecision(bot.id, d);
      try {
        await this.act(d, bar);
      } finally {
        this.store.updateBot(bot.id, { last_bar_time: barTime });
        this.refresh();
      }
      this.recordEquity(closeMs, bar.close, d.equityAtClose);
    });
  }

  async act(d, bar) {
    const bot = this.bot;
    let trade = await this.reconcile(bar);
    if (this.bot.status === "halted" && this.bot.halted_reason?.startsWith("position mismatch")) return;
    if (d.actions.length > 0) {
      this.log("info", "decision", `Engine at ${new Date(d.barTime * 1000).toISOString()}: ${d.actions.map((a) => `${a.type} ${a.side} (${a.reason})`).join(", ")}`, {
        barTime: d.barTime,
        actions: d.actions,
        target: d.targetPosition,
      });
    }
    for (const a of d.actions) {
      trade = this.store.openTrade(bot.id);
      if (a.type === "EXIT") {
        if (trade && !trade.manual && trade.side === a.side) await this.closePosition(a.reason, { price: bar.close });
      } else if (!trade) {
        await this.openPosition(a.side, a.reason, { barTime: d.barTime, price: bar.close });
      } else {
        this.log("info", "entry_skipped", `Engine entry ${a.side} skipped: the bot already holds a ${trade.manual ? "manual " : ""}${trade.side}`);
      }
    }
    trade = this.store.openTrade(bot.id);
    if (trade && !trade.manual && sign(trade.side) !== d.targetPosition) {
      await this.closePosition(d.targetPosition === 0 ? "ENGINE_FLAT" : "ENGINE_REVERSED", { price: bar.close });
    }
  }

  /** Brings the bot's open trade in line with the account. Returns the open trade after it. */
  async reconcile(bar) {
    const bot = this.bot;
    const trade = this.store.openTrade(bot.id);
    const pos = await this.exchange.position(bot.symbol, trade);
    if (trade && pos.dir === 0) {
      const fills = await this.exchange.exitFills(bot.symbol, sign(trade.side), trade.entry_time, trade);
      let reason = fills?.reason ?? (await this.exchange.firedProtective(bot.symbol, trade.protective));
      const price = fills?.avgPrice ?? bar.close;
      if (!reason) {
        const dStop = trade.stop_price !== null ? Math.abs(price - trade.stop_price) : Infinity;
        const dTp = trade.take_profit_price !== null ? Math.abs(price - trade.take_profit_price) : Infinity;
        reason = dStop === Infinity && dTp === Infinity ? "EXCHANGE_EXIT" : dStop <= dTp ? "STOP_LOSS" : "TAKE_PROFIT";
      }
      await this.exchange.cancelProtective(bot.symbol, trade);
      await this.bookExit(trade, { price, fee: fills?.fee ?? trade.qty * price * this.lab.execution.takerFeeRate, time: fills?.time ?? this.now(), reason });
      if (!fills) this.log("warn", "exit_price_unknown", `Position closed on the exchange; no fills found, booked at the close ${price}`);
      return null;
    }
    if (!trade && pos.dir !== 0) {
      this.halt(`position mismatch: the exchange holds a ${sideOf(pos.dir)} ${pos.qty} ${bot.symbol} this bot did not open`);
      return null;
    }
    if (trade && pos.dir !== sign(trade.side)) {
      this.halt(`position mismatch: the bot's trade is ${trade.side}, the exchange holds ${sideOf(pos.dir)} ${pos.qty}`);
      return trade;
    }
    if (trade && this.exchange.kind === "futures" && Math.abs(pos.qty - trade.qty) > trade.qty * 1e-6) {
      this.log("warn", "position_size_changed", `Position size on the exchange is ${pos.qty}, the trade recorded ${trade.qty}; following the exchange`);
      this.store.updateTrade(trade.id, { qty: pos.qty });
    }
    return this.store.openTrade(bot.id);
  }

  clientId(purpose) {
    return `bb${this.bot.id}-${purpose}-${this.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
  }

  wallet() {
    return this.bot.execution.capital + this.store.realizedPnl(this.bot.id);
  }

  /** Opens `side` at market. `price` is the reference for sizing (the decision's close or the last price). */
  async openPosition(side, reason, { barTime = null, price, manual = false, stopLossPct, takeProfitPct } = {}) {
    const bot = this.bot;
    const refusal = this.risk.entryRefusal(bot);
    if (refusal && !(manual && bot.status === "halted")) {
      this.log("warn", "entry_refused", `${side} entry refused: ${refusal}`);
      return null;
    }
    if (bot.market === "spot" && side === "short") {
      this.log("warn", "entry_refused", "Spot bots cannot short");
      return null;
    }
    const fraction = this.exchange.kind === "paper" ? 1 : (bot.execution.equityFraction ?? 0.98);
    const qty = entryQty(this.lab, this.venue.rules, this.wallet(), price, fraction);
    if (!(qty > 0)) {
      this.log("warn", "entry_too_small", `${side} entry skipped: the bot's ${this.wallet().toFixed(2)} USDT buys less than one lot or the minimum order value at ${price}`);
      return null;
    }
    const leverage = this.lab.execution.leverage;
    if (this.exchange.kind !== "paper") {
      const need = (qty * price) / leverage;
      const available = await this.exchange.availableBalance();
      if (available < need) {
        this.log("error", "entry_refused", `${side} entry needs ${need.toFixed(2)} USDT margin, the account has ${available.toFixed(2)} available`);
        this.failed("insufficient balance");
        return null;
      }
    }
    const clientId = this.clientId("in");
    const orderId = this.store.insertOrder({
      botId: bot.id, clientId, account: bot.account, market: bot.market, symbol: bot.symbol,
      side: side === "long" ? "BUY" : "SELL", type: "MARKET", purpose: manual ? "manual_entry" : "entry", qty, status: "sending",
    });
    let fill;
    try {
      fill = await this.exchange.marketOrder({ symbol: bot.symbol, side: side === "long" ? "BUY" : "SELL", qty, clientId });
    } catch (e) {
      this.store.updateOrder(orderId, { status: "error", error: e.message });
      this.log("error", "order_failed", `${side} entry order failed: ${e.message}`);
      this.failed(e.message);
      return null;
    }
    this.store.updateOrder(orderId, { status: "filled", exchange_id: fill.orderId, avg_price: fill.avgPrice, filled_qty: fill.qty, fee: fill.fee });
    this.risk.orderSucceeded(bot.id);
    const heldQty = fill.netQty ?? fill.qty;
    const lab = manual && (stopLossPct !== undefined || takeProfitPct !== undefined)
      ? { ...this.lab, strategy: { ...this.lab.strategy, stopLossPct: stopLossPct ?? null, takeProfitPct: takeProfitPct ?? null } }
      : this.lab;
    const levels = protectiveLevels(lab, this.venue.rules, side, fill.avgPrice);
    const tradeId = this.store.insertTrade({
      botId: bot.id, side, qty: heldQty, leverage, entryTime: fill.time, entryPrice: fill.avgPrice, entryFee: fill.fee,
      entryReason: reason, engineBarTime: barTime, stopPrice: levels.stopLoss, takeProfitPrice: levels.takeProfit, manual,
    });
    this.log("info", "position_opened", `Opened ${side} ${heldQty} ${bot.symbol} at ${fill.avgPrice} (${reason})`, {
      tradeId, qty: heldQty, price: fill.avgPrice, reference: price, slippagePct: ((fill.avgPrice - price) / price) * 100 * sign(side), fee: fill.fee,
    });
    if (this.exchange.kind === "futures" && bot.execution.marginType !== "CROSSED" && Math.ceil(leverage - 1e-9) !== leverage) {
      const topUp = (fill.qty * fill.avgPrice) / leverage - (fill.qty * fill.avgPrice) / Math.ceil(leverage - 1e-9);
      try {
        await this.exchange.addMargin(bot.symbol, topUp);
        this.log("info", "margin_added", `Added ${topUp.toFixed(4)} USDT isolated margin so the position runs at ${leverage}x`);
      } catch (e) {
        this.log("warn", "margin_add_failed", `Could not add margin for ${leverage}x (the position runs at ${Math.ceil(leverage)}x margin): ${e.message}`);
      }
    }
    if (levels.stopLoss !== null || levels.takeProfit !== null) {
      let placed = null;
      let lastError = null;
      for (let attempt = 0; attempt < 2 && placed === null; attempt++) {
        try {
          placed = await this.exchange.placeProtective({
            symbol: bot.symbol, dir: sign(side), qty: heldQty, stopLoss: levels.stopLoss, takeProfit: levels.takeProfit,
            workingType: bot.execution.workingType ?? "CONTRACT_PRICE", clientPrefix: `bb${bot.id}-t${tradeId}`, tradeId,
          });
        } catch (e) {
          lastError = e;
        }
      }
      if (placed === null) {
        this.log("error", "protective_failed", `Stop/target could not be placed (${lastError?.message}); closing the position rather than leaving it unprotected`);
        this.failed(lastError?.message ?? "protective orders failed");
        await this.closePosition("PROTECTIVE_FAILED", { price: fill.avgPrice });
        return null;
      }
      this.store.updateTrade(tradeId, { protective: placed });
      this.log("info", "protective_placed", `Stop ${levels.stopLoss ?? "-"}, target ${levels.takeProfit ?? "-"}`, placed);
    }
    return tradeId;
  }

  /** Closes the bot's open position at market. */
  async closePosition(reason, { price = null, manual = false } = {}) {
    const bot = this.bot;
    const trade = this.store.openTrade(bot.id);
    if (!trade) return null;
    const pos = await this.exchange.position(bot.symbol, trade);
    if (pos.dir === 0) {
      await this.reconcile({ close: price ?? trade.entry_price });
      return null;
    }
    await this.exchange.cancelProtective(bot.symbol, trade);
    const qty = this.exchange.kind === "futures" ? pos.qty : floorToStep(trade.qty, this.venue.filters.stepSize);
    const side = trade.side === "long" ? "SELL" : "BUY";
    const clientId = this.clientId("out");
    const orderId = this.store.insertOrder({
      botId: bot.id, clientId, account: bot.account, market: bot.market, symbol: bot.symbol, side, type: "MARKET",
      purpose: manual ? "manual_exit" : "exit", qty, status: "sending",
    });
    let fill;
    try {
      fill = await this.exchange.marketOrder({ symbol: bot.symbol, side, qty, reduceOnly: true, clientId });
    } catch (e) {
      this.store.updateOrder(orderId, { status: "error", error: e.message });
      this.log("error", "order_failed", `Exit order failed (${reason}): ${e.message}`);
      this.failed(e.message);
      if (trade.protective && (trade.stop_price !== null || trade.take_profit_price !== null)) {
        try {
          const placed = await this.exchange.placeProtective({
            symbol: bot.symbol, dir: sign(trade.side), qty: trade.qty, stopLoss: trade.stop_price, takeProfit: trade.take_profit_price,
            workingType: bot.execution.workingType ?? "CONTRACT_PRICE", clientPrefix: `bb${bot.id}-t${trade.id}r`, tradeId: trade.id,
          });
          this.store.updateTrade(trade.id, { protective: placed });
        } catch (e2) {
          this.log("error", "protective_failed", `Stop/target could not be restored after the failed exit: ${e2.message}`);
        }
      }
      return null;
    }
    this.store.updateOrder(orderId, { status: "filled", exchange_id: fill.orderId, avg_price: fill.avgPrice, filled_qty: fill.qty, fee: fill.fee });
    this.risk.orderSucceeded(bot.id);
    if (price !== null) {
      this.log("info", "exit_fill", `Exit filled at ${fill.avgPrice} against the reference ${price}`, { slippagePct: ((price - fill.avgPrice) / price) * 100 * sign(trade.side) });
    }
    return this.bookExit(trade, { price: fill.avgPrice, fee: fill.fee, time: fill.time, reason });
  }

  async bookExit(trade, { price, fee, time, reason }) {
    let funding = 0;
    try {
      funding = await this.exchange.fundingSince(this.bot.symbol, trade.entry_time);
    } catch (e) {
      this.log("warn", "funding_unavailable", `Funding for the trade unavailable: ${e.message}`);
    }
    const gross = (price - trade.entry_price) * trade.qty * sign(trade.side);
    const pnl = gross - trade.entry_fee - fee + funding;
    this.store.updateTrade(trade.id, { status: "closed", exit_time: time, exit_price: price, exit_fee: fee, exit_reason: reason, funding, pnl });
    this.log("info", "position_closed", `Closed ${trade.side} ${trade.qty} ${this.bot.symbol} at ${price} (${reason}), P&L ${pnl.toFixed(2)} USDT`, {
      tradeId: trade.id, price, pnl, funding, fee,
    });
    return trade.id;
  }

  failed(message) {
    const n = this.risk.orderFailed(this.bot.id);
    const max = this.bot.risk?.maxConsecutiveFailures ?? 5;
    if (n >= max && this.bot.status === "running") this.halt(`${n} order failures in a row (last: ${message})`);
  }

  recordEquity(timeMs, close, engineEquity) {
    const trade = this.store.openTrade(this.bot.id);
    const unrealized = trade ? (close - trade.entry_price) * trade.qty * sign(trade.side) : 0;
    const equity = this.wallet() + unrealized;
    this.store.insertEquity(this.bot.id, timeMs, equity, engineEquity);
    if (this.bot.status !== "running") return;
    const history = this.store.equity(this.bot.id, this.bot.started_at ?? 0).map((p) => ({ time: p.time, equity: p.equity }));
    const breach = this.risk.equityBreach(this.bot, history);
    if (breach) {
      this.halt(breach);
      if (this.bot.risk?.flattenOnHalt) this.enqueue(() => this.closePosition("RISK_HALT", { price: close }));
    }
  }

  /** Owner actions from the UI, queued behind any bar in progress. */
  manualOpen(side, opts = {}) {
    return this.enqueue(async () => {
      this.refresh();
      const price = await this.market.price(this.bot.market, this.bot.symbol);
      if (this.exchange.kind === "paper") this.exchange.setReferencePrice(this.bot.symbol, price);
      const open = this.store.openTrade(this.bot.id);
      if (open) throw new Error(`The bot already holds a ${open.side}; close it first`);
      return this.openPosition(side, "MANUAL", { price, manual: true, ...opts });
    });
  }

  manualClose() {
    return this.enqueue(async () => {
      this.refresh();
      const price = await this.market.price(this.bot.market, this.bot.symbol);
      if (this.exchange.kind === "paper") this.exchange.setReferencePrice(this.bot.symbol, price);
      return this.closePosition("MANUAL", { price, manual: true });
    });
  }

  /** The engine's backtest over the bars since the bot's anchor, for the live-against-backtest view. */
  backtestSinceAnchor() {
    const bot = this.bot;
    const candles = this.store.candles(bot.market, bot.symbol, bot.timeframe, bot.anchor_time ?? 0);
    if (candles.length < 2) return null;
    return backtest(this.lab, this.venue.rules, this.labSymbol, candles, { funding: this.funding });
  }
}

/** Floors a quantity to the exchange step (decimal string), as a number. */
export function floorToStep(qty, stepSize) {
  const decimals = (stepSize.split(".")[1] ?? "").replace(/0+$/, "").length;
  const step = Number(stepSize);
  const units = Math.floor(qty / step + 1e-9);
  return Number((units * step).toFixed(decimals));
}
