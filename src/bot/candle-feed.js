// Closed bars for every (market, symbol, timeframe) a bot trades. The websocket delivers each bar as it closes;
// a timer a few seconds after every bar close checks the store and fetches over REST whatever the socket
// missed, so a dead socket delays a decision by seconds, never skips it. Gaps are backfilled before a bar is
// announced, and each key announces strictly newer bars only.
import { EventEmitter } from "node:events";
import { TIMEFRAMES } from "../engine.js";

const keyOf = (market, symbol, timeframe) => `${market}:${symbol}:${timeframe}`;

export class CandleFeed extends EventEmitter {
  constructor({ store, market, streams, events, now = () => Date.now(), setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, settleMs = 2500 }) {
    super();
    this.store = store;
    this.market = market;
    this.streams = streams;
    this.events = events;
    this.now = now;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.settleMs = settleMs;
    this.subs = new Map();
    this.announced = new Map();
    this.busy = new Map();
    for (const s of Object.values(streams)) s.on("bar", (m) => this.onStreamBar(m));
  }

  subscribe(market, symbol, timeframe) {
    const key = keyOf(market, symbol, timeframe);
    const sub = this.subs.get(key);
    if (sub) {
      sub.refs++;
      return;
    }
    this.subs.set(key, { market, symbol, timeframe, sec: TIMEFRAMES[timeframe].sec, refs: 1, timer: null });
    const last = this.store.lastCandleTime(market, symbol, timeframe);
    if (last !== null && !this.announced.has(key)) this.announced.set(key, last);
    this.schedule(key);
    this.updateStreams();
  }

  unsubscribe(market, symbol, timeframe) {
    const key = keyOf(market, symbol, timeframe);
    const sub = this.subs.get(key);
    if (!sub) return;
    if (--sub.refs > 0) return;
    if (sub.timer) this.clearTimeout(sub.timer);
    this.subs.delete(key);
    this.updateStreams();
  }

  updateStreams() {
    for (const market of Object.keys(this.streams)) {
      const list = [...this.subs.values()].filter((s) => s.market === market).map((s) => ({ symbol: s.symbol, interval: TIMEFRAMES[s.timeframe].binance }));
      this.streams[market].setStreams(list);
    }
  }

  /** Newest bar whose close has passed. */
  lastClosedTime(sec) {
    return Math.floor(this.now() / 1000 / sec) * sec - sec;
  }

  /** Makes the store hold every closed bar from `fromSec` on. */
  async ensureHistory(market, symbol, timeframe, fromSec) {
    const { sec, binance } = TIMEFRAMES[timeframe];
    const to = this.lastClosedTime(sec);
    const have = this.store.candles(market, symbol, timeframe, fromSec, to);
    const expected = Math.floor((to - fromSec) / sec) + 1;
    if (have.length === expected && have[0]?.time === fromSec) return have.length;
    let start = fromSec;
    if (have.length > 0 && have[0].time === fromSec) {
      // Contiguous prefix: fetch from the first hole on.
      let i = 1;
      while (i < have.length && have[i].time === have[i - 1].time + sec) i++;
      start = have[i - 1].time + sec;
    }
    const bars = await this.market.closedKlines(market, symbol, binance, sec, start, to);
    this.store.upsertCandles(market, symbol, timeframe, bars);
    const now = this.store.candles(market, symbol, timeframe, fromSec, to);
    if (now.length !== expected) {
      this.events.warn("history_incomplete", `${market} ${symbol} ${timeframe}: ${now.length} of ${expected} bars since ${new Date(fromSec * 1000).toISOString()} (Binance may not list older bars)`);
    }
    return now.length;
  }

  schedule(key) {
    const sub = this.subs.get(key);
    if (!sub) return;
    if (sub.timer) this.clearTimeout(sub.timer);
    const nextClose = (Math.floor(this.now() / 1000 / sub.sec) + 1) * sub.sec * 1000;
    sub.timer = this.setTimeout(() => {
      sub.timer = null;
      this.catchUp(key).finally(() => this.schedule(key));
    }, Math.max(0, nextClose - this.now()) + this.settleMs);
  }

  onStreamBar({ market, symbol, interval, bar }) {
    for (const [key, sub] of this.subs) {
      if (sub.market !== market || sub.symbol !== symbol || TIMEFRAMES[sub.timeframe].binance !== interval) continue;
      const prev = this.store.lastCandleTime(market, symbol, sub.timeframe);
      this.store.upsertCandles(market, symbol, sub.timeframe, [bar]);
      if (prev !== null && bar.time > prev + sub.sec) this.catchUp(key);
      else this.announce(key, bar.time);
    }
  }

  /** Fetches what the store lacks up to the newest closed bar, then announces it. One run per key at a time. */
  catchUp(key) {
    const running = this.busy.get(key);
    if (running) return running;
    const run = (async () => {
      const sub = this.subs.get(key);
      if (!sub) return;
      const target = this.lastClosedTime(sub.sec);
      const last = this.store.lastCandleTime(sub.market, sub.symbol, sub.timeframe);
      if (last === null || last < target) {
        try {
          const from = last === null ? target : last + sub.sec;
          const bars = await this.market.closedKlines(sub.market, sub.symbol, TIMEFRAMES[sub.timeframe].binance, sub.sec, from, target);
          this.store.upsertCandles(sub.market, sub.symbol, sub.timeframe, bars);
        } catch (e) {
          this.events.warn("klines_unavailable", `${key}: ${e.message}`);
          return;
        }
      }
      const newest = this.store.lastCandleTime(sub.market, sub.symbol, sub.timeframe);
      if (newest !== null) this.announce(key, newest);
    })().finally(() => this.busy.delete(key));
    this.busy.set(key, run);
    return run;
  }

  announce(key, time) {
    const prev = this.announced.get(key);
    if (prev !== undefined && time <= prev) return;
    this.announced.set(key, time);
    const sub = this.subs.get(key);
    if (sub) this.emit("bar", { market: sub.market, symbol: sub.symbol, timeframe: sub.timeframe, time });
  }

  close() {
    for (const s of this.subs.values()) if (s.timer) this.clearTimeout(s.timer);
    this.subs.clear();
    for (const s of Object.values(this.streams)) s.close();
  }
}
