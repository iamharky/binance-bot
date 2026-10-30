// Binance REST client for spot (/api/v3) and USD-M futures (/fapi), live or demo. Signed requests use
// HMAC-SHA256 over the query string, a server-time offset (resynced on -1021) and a recvWindow. Errors carry
// Binance's code and message; 429 / 418 pause the client until Retry-After passes.
import { createHmac } from "node:crypto";

export const BASE_URLS = {
  spot: { live: "https://api.binance.com", demo: "https://demo-api.binance.com" },
  futures: { live: "https://fapi.binance.com", demo: "https://demo-fapi.binance.com" },
};

const TIME_PATH = { spot: "/api/v3/time", futures: "/fapi/v1/time" };

export class BinanceError extends Error {
  constructor(status, code, msg, path) {
    super(`Binance ${path}: ${code !== null ? `${code} ` : ""}${msg} (HTTP ${status})`);
    this.name = "BinanceError";
    this.status = status;
    this.code = code;
    this.binanceMessage = msg;
    this.path = path;
  }

  /** True when retrying the same request can succeed (timeouts, 5xx, rate limits). An order may still have landed: query before resending. */
  get transient() {
    return this.status === 0 || this.status >= 500 || this.status === 429 || this.status === 418 || this.code === -1001 || this.code === -1007;
  }
}

export class BinanceRest {
  /**
   * @param {{market: "spot"|"futures", env: "live"|"demo", apiKey?: string, apiSecret?: string,
   *          fetch?: typeof fetch, now?: () => number, recvWindow?: number, timeoutMs?: number}} opts
   */
  constructor({ market, env, apiKey = "", apiSecret = "", fetch: fetchImpl = globalThis.fetch, now = () => Date.now(), recvWindow = 5000, timeoutMs = 10_000 }) {
    if (!BASE_URLS[market]?.[env]) throw new Error(`Unknown Binance market/env ${market}/${env}`);
    this.market = market;
    this.env = env;
    this.base = BASE_URLS[market][env];
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.fetch = fetchImpl;
    this.now = now;
    this.recvWindow = recvWindow;
    this.timeoutMs = timeoutMs;
    this.timeOffset = 0;
    this.timeSyncedAt = 0;
    this.pausedUntil = 0;
    this.usedWeight = null;
  }

  get hasKeys() {
    return this.apiKey !== "" && this.apiSecret !== "";
  }

  async syncTime() {
    const before = this.now();
    const r = await this.request("GET", TIME_PATH[this.market], {}, { signed: false });
    const after = this.now();
    this.timeOffset = r.serverTime - Math.round((before + after) / 2);
    this.timeSyncedAt = after;
    return this.timeOffset;
  }

  publicGet(path, params = {}) {
    return this.request("GET", path, params, { signed: false });
  }

  async signed(method, path, params = {}) {
    if (!this.hasKeys) throw new Error(`No ${this.env} API key configured for ${this.market}`);
    if (this.now() - this.timeSyncedAt > 30 * 60 * 1000) await this.syncTime();
    try {
      return await this.request(method, path, params, { signed: true });
    } catch (e) {
      if (e instanceof BinanceError && e.code === -1021) {
        await this.syncTime();
        return this.request(method, path, params, { signed: true });
      }
      throw e;
    }
  }

  async request(method, path, params, { signed }) {
    const wait = this.pausedUntil - this.now();
    if (wait > 0) throw new BinanceError(429, null, `rate limited, paused for ${Math.ceil(wait / 1000)} s`, path);
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) qs.append(k, String(v));
    const headers = {};
    if (signed) {
      qs.append("recvWindow", String(this.recvWindow));
      qs.append("timestamp", String(this.now() + this.timeOffset));
      qs.append("signature", createHmac("sha256", this.apiSecret).update(qs.toString()).digest("hex"));
    }
    if (signed || this.apiKey) headers["X-MBX-APIKEY"] = this.apiKey;
    const query = qs.toString();
    const url = `${this.base}${path}${query ? `?${query}` : ""}`;
    let res;
    try {
      res = await this.fetch(url, { method, headers, signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new BinanceError(0, null, `network error: ${e.message}`, path);
    }
    const weight = res.headers?.get?.("x-mbx-used-weight-1m") ?? res.headers?.get?.("x-mbx-used-weight");
    if (weight) this.usedWeight = Number(weight);
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (res.status === 429 || res.status === 418) {
      const retry = Number(res.headers?.get?.("retry-after") ?? 60);
      this.pausedUntil = this.now() + (Number.isFinite(retry) ? retry : 60) * 1000;
    }
    if (!res.ok) throw new BinanceError(res.status, body?.code ?? null, body?.msg ?? (text.slice(0, 200) || res.statusText), path);
    if (body && typeof body === "object" && typeof body.code === "number" && body.code < 0 && body.msg) {
      throw new BinanceError(res.status, body.code, body.msg, path);
    }
    return body;
  }
}
