// Wires the app together. main.js runs it; tests build it with fakes (fetch, WebSocket, clock, in-memory DB).
import { MarketData } from "./binance/market.js";
import { KlineStream } from "./binance/stream.js";
import { CandleFeed } from "./bot/candle-feed.js";
import { BotManager } from "./bot/manager.js";
import { RiskGuard } from "./bot/risk.js";
import { openDb } from "./db.js";
import { EventLog } from "./events.js";
import { Auth } from "./server/auth.js";
import { buildRoutes, sseHandler } from "./server/api.js";
import { createHttpServer } from "./server/http.js";

export function createApp(config, { fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = () => Date.now(), quiet = false, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const store = openDb(config.dataDir);
  const events = new EventLog(store, { now, quiet });
  const risk = new RiskGuard(store);
  const market = new MarketData({ fetch: fetchImpl, now });
  const streams = {
    spot: new KlineStream({ market: "spot", WebSocketImpl, setTimeoutImpl, clearTimeoutImpl }),
    futures: new KlineStream({ market: "futures", WebSocketImpl, setTimeoutImpl, clearTimeoutImpl }),
  };
  for (const [m, s] of Object.entries(streams)) {
    s.on("status", (st) => events.emit(st.connected ? "info" : "warn", "stream", `${m} market stream ${st.connected ? "connected" : "disconnected"}${st.error ? `: ${st.error}` : ""}`));
  }
  const feed = new CandleFeed({ store, market, streams, events, now, setTimeoutImpl, clearTimeoutImpl });
  const manager = new BotManager({ store, events, risk, market, feed, config, fetchImpl, now });
  const auth = new Auth(store, { secureCookie: config.cookieSecure, now });
  const server = createHttpServer({ auth, routes: buildRoutes({ store, manager, auth, events, config, streams }), sse: sseHandler(events), trustProxy: config.trustProxy === true });
  return {
    store, events, risk, market, streams, feed, manager, auth, server,
    async close() {
      feed.close();
      const closed = new Promise((r) => server.close(() => r()));
      server.closeAllConnections?.();
      await closed;
      store.close();
    },
  };
}
