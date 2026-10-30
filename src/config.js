// Process configuration: environment variables, optionally from a .env file next to package.json.
// Secrets (API keys, Telegram token) live only here, never in the database or in logs.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Parses KEY=VALUE lines (# comments, optional quotes). Existing process env wins. */
export function loadDotEnv(path = join(ROOT, ".env")) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

function bool(v, dflt) {
  if (v === undefined || v === "") return dflt;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function readConfig(env = process.env) {
  const port = Number(env.PORT ?? 8787);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT must be a port number, got ${env.PORT}`);
  return {
    port,
    host: env.HOST || "127.0.0.1",
    dataDir: resolve(ROOT, env.DATA_DIR || "data"),
    /** Set to 1 behind HTTPS (the VPS): session cookies then carry Secure. */
    cookieSecure: bool(env.COOKIE_SECURE, false),
    /** Set to 1 behind a reverse proxy (nginx, Caddy) so login throttling sees the client's IP. */
    trustProxy: bool(env.TRUST_PROXY, false),
    /** Live-account bots refuse to start unless this is 1: one deliberate switch before real money moves. */
    liveTradingEnabled: bool(env.LIVE_TRADING_ENABLED, false),
    bistChartsDir: resolve(ROOT, env.BIST_CHARTS_DIR || "../bist-charts"),
    keys: {
      demo: { apiKey: env.BINANCE_DEMO_API_KEY || "", apiSecret: env.BINANCE_DEMO_API_SECRET || "" },
      live: { apiKey: env.BINANCE_LIVE_API_KEY || "", apiSecret: env.BINANCE_LIVE_API_SECRET || "" },
    },
    telegram: { token: env.TELEGRAM_BOT_TOKEN || "", chatId: env.TELEGRAM_CHAT_ID || "" },
  };
}
