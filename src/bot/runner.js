// One bot: at every closed bar it asks the engine what the strategy does at this close (decideAtClose over the
// bars since the bot's anchor) and makes the account match.
//
// Rules, in order, on each closed bar:
// 0. Limit entries (a strategy with entryLimit): the bot's working limit order is checked first, so a fill is a
//    trade before anything reconciles. It keeps working while its window is open (through the engine order's last
//    bar) and the engine still works that order or filled it; a fill books the trade at the exchange's fill and
//    puts the stop and target on the exchange. Otherwise it is cancelled: a part already filled is booked (and
//    closed at once when the engine no longer wants that side), and when the window closed unfilled while the
//    engine holds the position (its bar traded at the limit, the exchange did not fill) the bot enters at market.
//    Between closes a demo or live bot polls the order, so the stop goes on within seconds of a fill.
// 1. Reconcile: a position the exchange closed (stop, target, liquidation) closes the bot's trade at the
//    exchange's fills; a position the bot did not open, or one on the wrong side, halts the bot.
// 2. Act on the decision's actions in ledger order: an EXIT closes the bot's position on that side; an ENTRY
//    opens one when the bot is flat, works no limit entry and entries are allowed (kill switch, halt): "next_open"
//    at market (the engine fills it at the next bar's open, which a 24x7 market prints right after this close),
//    "limit" as a limit order at the engine's price. Entries are sized as the engine sizes them: its sizeFraction
//    of the bot's wallet (all of it without volatility sizing), a limit at its price with the maker fee.
// 3. Follow the engine when they differ: the engine flat (its stop or target hit this bar, but the exchange's
//    did not) or on the other side closes the bot's position, unless the bot's limit filled first and the engine
//    still works that same order. The bot never opens a position the engine entered earlier (after downtime, a
//    refused entry or a manual close): it waits for the next entry; the one exception is rule 0's fallback.
// Manual trades are the owner's: the engine's exits and rule 3 leave them alone.
// Stop and target are placed on the exchange right after every fill, at the engine's levels from the real fill.
import { backtest, decide, ENGINE_INFO, entryQty, labSymbol, parseLabSettings, protectiveLevels, TIMEFRAMES } from "../engine.js";

const sign = (side) => (side === "short" ? -1 : 1);
const sideOf = (dir) => (dir === -1 ? "short" : "long");
const iso = (sec) => new Date(sec * 1000).toISOString();
const WORKING = new Set(["NEW", "PARTIALLY_FILLED"]);

export class BotRunner {
  /**
   * @param {{bot: object, store: import("../db.js").Store, events: import("../events.js").EventLog,
   *          risk: import("./risk.js").RiskGuard, exchange: object, market: import("../binance/market.js").MarketData,
   *          feed: object, venue: {filters: object, rules: object}, now?: () => number,
   *          setTimeoutImpl?: Function, clearTimeoutImpl?: Function, pollMs?: number}} deps
   */
  constructor({ bot, store, events, risk, exchange, market, feed, venue, now = () => Date.now(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, pollMs = 5000 }) {
    this.store = store;
    this.events = events;
    this.risk = risk;
    this.exchange = exchange;
    this.market = market;
    this.feed = feed;
    this.venue = venue;
    this.now = now;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.pollMs = pollMs;
    this.pollTimer = null;
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

  /** The limit entry the bot keeps working on the exchange, or null. */
  get working() {
    return this.bot.working_entry ?? null;
  }

  setWorking(w) {
    this.store.updateBot(this.bot.id, { working_entry: w });
    this.refresh();
    if (w === null) this.stopPoll();
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
      if (this.working) this.startPoll();
      this.log("info", "bot_started", `${bot.name} started on ${bot.account} ${bot.market} ${bot.symbol} ${bot.timeframe}`, {
        anchorTime: anchor,
        exchangeLeverage: prep?.exchangeLeverage ?? 1,
        leverage: this.lab.execution.leverage,
      });
    });
  }

  stop({ flatten = false } = {}) {
    return this.enqueue(async () => {
      if (this.working) await this.cancelWorking("bot stopped");
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
    if (this.working) await this.syncWorking(d, bar);
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
      } else if (trade || this.working) {
        const held = trade ? `a ${trade.manual ? "manual " : ""}${trade.side}` : `a working ${this.working.side} limit`;
        this.log("info", "entry_skipped", `Engine entry ${a.side} skipped: the bot already holds ${held}`);
      } else if (a.at === "limit") {
        await this.placeLimitEntry(a, d.barTime);
      } else {
        await this.openPosition(a.side, a.reason, { barTime: d.barTime, price: bar.close, sizeFraction: a.sizeFraction ?? 1 });
      }
    }
    trade = this.store.openTrade(bot.id);
    if (trade && !trade.manual && sign(trade.side) !== d.targetPosition) {
      const w = d.workingEntry;
      const engineStillWorks = trade.entry_reason === "LIMIT_ENTRY" && d.targetPosition === 0 && w !== null && w.side === trade.side && w.signalBarTime === trade.engine_bar_time;
      if (!engineStillWorks) await this.closePosition(d.targetPosition === 0 ? "ENGINE_FLAT" : "ENGINE_REVERSED", { price: bar.close });
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

  /** Why the bot may not enter now (risk limits, kill switch, a spot short), else null. */
  entryRefusal(side, manual = false) {
    const bot = this.bot;
    const refusal = this.risk.entryRefusal(bot);
    if (refusal && !(manual && bot.status === "halted")) return `${side} entry refused: ${refusal}`;
    if (bot.market === "spot" && side === "short") return "Spot bots cannot short";
    return null;
  }

  /** The exchange margin an entry of `qty` at `price` needs, refused (and counted as a failure) when it is not there. */
  async marginAvailable(side, qty, price) {
    if (this.exchange.kind === "paper") return true;
    const need = (qty * price) / this.lab.execution.leverage;
    const available = await this.exchange.availableBalance();
    if (available >= need) return true;
    this.log("error", "entry_refused", `${side} entry needs ${need.toFixed(2)} USDT margin, the account has ${available.toFixed(2)} available`);
    this.failed("insufficient balance");
    return false;
  }

  /**
   * Opens `side` at market. `price` is the reference for sizing (the decision's close or the last price);
   * `sizeFraction` the engine's share of the wallet (1 = all-in).
   */
  async openPosition(side, reason, { barTime = null, price, manual = false, stopLossPct, takeProfitPct, sizeFraction = 1 } = {}) {
    const bot = this.bot;
    const refusal = this.entryRefusal(side, manual);
    if (refusal) {
      this.log("warn", "entry_refused", refusal);
      return null;
    }
    const fraction = this.exchange.kind === "paper" ? 1 : (bot.execution.equityFraction ?? 0.98);
    const qty = entryQty(this.lab, this.venue.rules, this.wallet(), price, fraction, sizeFraction);
    if (!(qty > 0)) {
      this.log("warn", "entry_too_small", `${side} entry skipped: the bot's ${this.wallet().toFixed(2)} USDT buys less than one lot or the minimum order value at ${price}`);
      return null;
    }
    if (!(await this.marginAvailable(side, qty, price))) return null;
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
    return this.afterEntry(side, fill, { reason, barTime, manual, stopLossPct, takeProfitPct, reference: price });
  }

  /** Books a filled entry as the bot's trade and puts its stop and target on the exchange (closing it if they fail). */
  async afterEntry(side, fill, { reason, barTime = null, manual = false, stopLossPct, takeProfitPct, reference = null }) {
    const bot = this.bot;
    this.risk.orderSucceeded(bot.id);
    const leverage = this.lab.execution.leverage;
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
      tradeId, qty: heldQty, price: fill.avgPrice, reference, slippagePct: reference ? ((fill.avgPrice - reference) / reference) * 100 * sign(side) : null, fee: fill.fee,
    });
    if (this.exchange.kind === "futures" && bot.execution.marginType !== "CROSSED" && Math.ceil(leverage - 1e-9) !== leverage) {
      const topUp = (heldQty * fill.avgPrice) / leverage - (heldQty * fill.avgPrice) / Math.ceil(leverage - 1e-9);
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

  /** The engine's limit entry (an action at "limit"): a limit order at its price, sized with the maker fee. */
  async placeLimitEntry(a, barTime) {
    const bot = this.bot;
    const refusal = this.entryRefusal(a.side);
    if (refusal) {
      this.log("warn", "entry_refused", refusal);
      return null;
    }
    const price = roundToTick(a.limitPrice, this.venue.filters.tickSize);
    const fraction = this.exchange.kind === "paper" ? 1 : (bot.execution.equityFraction ?? 0.98);
    const qty = entryQty(this.lab, this.venue.rules, this.wallet(), price, fraction, a.sizeFraction ?? 1, this.lab.execution.makerFeeRate);
    if (!(qty > 0)) {
      this.log("warn", "entry_too_small", `${a.side} limit entry skipped: the bot's ${this.wallet().toFixed(2)} USDT buys less than one lot or the minimum order value at ${price}`);
      return null;
    }
    if (!(await this.marginAvailable(a.side, qty, price))) return null;
    const side = a.side === "long" ? "BUY" : "SELL";
    const clientId = this.clientId("lim");
    const orderId = this.store.insertOrder({ botId: bot.id, clientId, account: bot.account, market: bot.market, symbol: bot.symbol, side, type: "LIMIT", purpose: "entry_limit", qty, price, status: "sending" });
    let placed;
    try {
      placed = await this.exchange.limitOrder({ symbol: bot.symbol, side, qty, price, clientId });
    } catch (e) {
      this.store.updateOrder(orderId, { status: "error", error: e.message });
      this.log("error", "order_failed", `${a.side} limit entry failed: ${e.message}`);
      this.failed(e.message);
      return null;
    }
    this.store.updateOrder(orderId, { status: "working", exchange_id: placed.orderId });
    this.risk.orderSucceeded(bot.id);
    const w = { clientId, orderId, side: a.side, price, qty, sizeFraction: a.sizeFraction ?? 1, signalBarTime: barTime, lastBarTime: a.lastBarTime, fallback: a.fallback ?? "market" };
    this.setWorking(w);
    this.log("info", "limit_placed", `Limit ${a.side} ${qty} ${bot.symbol} at ${price}, working through the ${iso(a.lastBarTime)} bar`, w);
    if (placed.status === "FILLED") return this.limitFilled(w, await this.exchange.orderState(bot.symbol, clientId));
    this.startPoll();
    return null;
  }

  /** Rule 0: the working limit entry against the exchange and the engine's decision `d` at this close. */
  async syncWorking(d, bar) {
    const bot = this.bot;
    const w = this.working;
    let st = await this.exchange.orderState(bot.symbol, w.clientId);
    if (st.status === "FILLED") return this.limitFilled(w, st);
    const engineWorks = d.workingEntry !== null && d.workingEntry.side === w.side && d.workingEntry.signalBarTime === w.signalBarTime;
    const engineFilled = d.positionAtClose === sign(w.side) && d.openEntry !== null && d.openEntry.side === w.side && d.openEntry.time > w.signalBarTime;
    const windowOpen = d.barTime < w.lastBarTime;
    const refused = this.entryRefusal(w.side);
    if (WORKING.has(st.status) && windowOpen && (engineWorks || engineFilled) && !refused) return null;
    if (WORKING.has(st.status)) {
      st = await this.exchange.cancelOrder(bot.symbol, w.clientId);
      if (st.status === "FILLED") return this.limitFilled(w, st);
    }
    this.store.updateOrder(w.orderId, { status: st.status === "UNKNOWN" ? "lost" : "cancelled", filled_qty: st.executedQty ?? 0 });
    this.setWorking(null);
    if (st.executedQty > 0) {
      await this.limitFilled(w, st, true);
      if (refused || !(engineWorks || engineFilled)) await this.closePosition("ENGINE_CANCELLED", { price: bar.close });
      return null;
    }
    if (refused) {
      this.log("warn", "entry_refused", `${refused}; the limit at ${w.price} was cancelled`);
      return null;
    }
    if (!windowOpen && engineFilled) {
      this.log("info", "limit_unfilled", `The engine's bar traded at the limit ${w.price}, the exchange did not fill it; entering at market`);
      return this.openPosition(w.side, "LIMIT_FALLBACK", { barTime: d.barTime, price: bar.close, sizeFraction: w.sizeFraction });
    }
    this.log("info", "limit_ended", `Limit ${w.side} at ${w.price} ended unfilled${st.status === "UNKNOWN" ? " (gone from the exchange)" : ""}`);
    return null;
  }

  /** A limit entry filled (whole, or `partial` at its cancel): books the trade and its stop and target. */
  async limitFilled(w, st, partial = false) {
    if (this.working?.clientId === w.clientId) this.setWorking(null);
    this.store.updateOrder(w.orderId, { status: partial ? "partially_filled" : "filled", avg_price: st.avgPrice, filled_qty: st.executedQty, fee: st.fee ?? 0 });
    const fill = { orderId: st.orderId, avgPrice: st.avgPrice, qty: st.executedQty, fee: st.fee ?? 0, time: st.time ?? this.now() };
    return this.afterEntry(w.side, fill, { reason: "LIMIT_ENTRY", barTime: w.signalBarTime, reference: w.price });
  }

  /** Cancels the working limit entry (bot stopped); a part already filled stays a trade. */
  async cancelWorking(why) {
    const w = this.working;
    const st = await this.exchange.cancelOrder(this.bot.symbol, w.clientId);
    this.store.updateOrder(w.orderId, { status: "cancelled", filled_qty: st.executedQty ?? 0 });
    this.setWorking(null);
    this.log("info", "limit_cancelled", `Limit ${w.side} at ${w.price} cancelled: ${why}`);
    if (st.executedQty > 0) await this.limitFilled(w, st, true);
  }

  /** Demo and live bots poll a working limit between closes, so a fill gets its stop at once. */
  startPoll() {
    if (this.exchange.kind === "paper" || !(this.pollMs > 0) || this.pollTimer !== null || !this.working) return;
    this.pollTimer = this.setTimeout(() => {
      this.pollTimer = null;
      this.enqueue(() => this.pollWorking()).catch((e) => this.log("warn", "limit_poll_failed", `Limit order check failed: ${e.message}`));
    }, this.pollMs);
  }

  stopPoll() {
    if (this.pollTimer !== null) this.clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  async pollWorking() {
    const w = this.working;
    if (!w) return;
    const st = await this.exchange.orderState(this.bot.symbol, w.clientId);
    if (st.status === "FILLED") {
      await this.limitFilled(w, st);
      return;
    }
    if (!WORKING.has(st.status)) {
      this.store.updateOrder(w.orderId, { status: st.status === "UNKNOWN" ? "lost" : "cancelled", filled_qty: st.executedQty ?? 0 });
      this.setWorking(null);
      this.log("warn", "limit_lost", `Limit ${w.side} at ${w.price} is ${st.status} on the exchange (not cancelled by the bot)`);
      if (st.executedQty > 0) await this.limitFilled(w, st, true);
      return;
    }
    this.startPoll();
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
      if (this.working) throw new Error(`The bot is working a ${this.working.side} limit entry at ${this.working.price}; it fills or ends first`);
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

/** A price on the exchange tick (a decimal string or number) without binary noise, so it is sent as Binance prints it. */
export function roundToTick(price, tickSize) {
  const tick = Number(tickSize);
  return Number((Math.round(price / tick) * tick).toFixed(12));
}
