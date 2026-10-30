// Kline websocket (live market data). Emits a bar only when Binance marks its kline closed (k.x), reconnects with
// backoff, and reconnects whenever the set of streams changes. Binance drops every connection after 24 h; that
// is just another reconnect.
import { EventEmitter } from "node:events";

const WS_BASE = {
  spot: "wss://stream.binance.com:9443/stream?streams=",
  futures: "wss://fstream.binance.com/stream?streams=",
};

export class KlineStream extends EventEmitter {
  /** @param {{market: "spot"|"futures", WebSocketImpl?: typeof WebSocket, setTimeoutImpl?: typeof setTimeout}} opts */
  constructor({ market, WebSocketImpl = globalThis.WebSocket, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout }) {
    super();
    this.market = market;
    this.WebSocketImpl = WebSocketImpl;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.streams = [];
    this.ws = null;
    this.backoffMs = 1000;
    this.timer = null;
    this.closed = false;
    this.connected = false;
  }

  /** streams: [{symbol: "BTCUSDT", interval: "15m"}] (Binance interval names). */
  setStreams(streams) {
    const names = [...new Set(streams.map((s) => `${s.symbol.toLowerCase()}@kline_${s.interval}`))].sort();
    if (names.join("/") === this.streams.join("/")) return;
    this.streams = names;
    this.reconnect(0);
  }

  reconnect(delayMs) {
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {
        // Already closing.
      }
    }
    this.connected = false;
    if (this.closed || this.streams.length === 0) return;
    this.timer = this.setTimeout(() => this.connect(), delayMs);
  }

  connect() {
    this.timer = null;
    const url = WS_BASE[this.market] + this.streams.join("/");
    let ws;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (e) {
      this.emit("status", { connected: false, error: e.message });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.backoffMs = 1000;
      this.emit("status", { connected: true });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      } catch {
        return;
      }
      const k = msg?.data?.k;
      if (!k || k.x !== true) return;
      this.emit("bar", {
        market: this.market,
        symbol: k.s,
        interval: k.i,
        bar: { time: Math.floor(Number(k.t) / 1000), open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) },
      });
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      this.emit("status", { connected: false });
      this.scheduleRetry();
    };
  }

  scheduleRetry() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    this.reconnect(delay);
  }

  close() {
    this.closed = true;
    this.reconnect(0);
  }
}
