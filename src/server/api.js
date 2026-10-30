// The control API. Every route returns JSON; refusals answer {ok: false, error, field?} with a 4xx status.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { engine, ENGINE_INFO, parseLabSettings, TIMEFRAMES } from "../engine.js";
import { compareWithEngine, tradeStats } from "../stats.js";
import { HttpError } from "./http.js";

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `${name} must be a positive integer`);
  return n;
};

/** bist-charts commits newer than the bundled engine that touch the engine's sources (local checkout only). */
export function engineStatus(bistChartsDir) {
  const out = { ...ENGINE_INFO, inputs: ENGINE_INFO.inputs.length, newerEngineCommits: null };
  if (!existsSync(join(bistChartsDir, ".git"))) return out;
  try {
    const log = execFileSync("git", ["-C", bistChartsDir, "log", "--format=%h %cI %s", `${ENGINE_INFO.commit}..HEAD`, "--", ...ENGINE_INFO.inputs], { encoding: "utf8", timeout: 5000 });
    out.newerEngineCommits = log.split("\n").filter(Boolean);
  } catch {
    // Commit unknown to that checkout, or git missing: leave it unknown.
  }
  return out;
}

export function buildRoutes({ store, manager, auth, events, config, streams }) {
  const botView = (bot) => {
    const trade = store.openTrade(bot.id);
    const equity = store.equity(bot.id, bot.started_at ?? 0);
    const trades = store.trades({ botId: bot.id, limit: 100_000 }).filter((t) => (bot.started_at ? t.entry_time >= bot.started_at || t.status === "open" : true));
    return {
      ...bot,
      position: trade,
      stats: tradeStats(trades, equity, bot.execution.capital),
      lastEquity: equity.length > 0 ? equity[equity.length - 1] : null,
    };
  };

  const routes = [
    // Session.
    {
      method: "POST",
      path: "/api/login",
      public: true,
      handler: (ctx) => {
        const { sessionId } = auth.login(String(ctx.body.password ?? ""), ctx.ip, ctx.req.headers["user-agent"]);
        ctx.headers = { "Set-Cookie": auth.cookie(sessionId) };
        events.info("login", `Login from ${ctx.ip}`);
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: "/api/logout",
      public: true,
      handler: (ctx) => {
        auth.logout(ctx.req);
        ctx.headers = { "Set-Cookie": auth.clearCookie() };
        return { ok: true };
      },
    },
    { method: "GET", path: "/api/session", public: true, handler: (ctx) => ({ ok: true, loggedIn: ctx.session !== null, passwordSet: auth.passwordSet }) },

    // Overview and reference data.
    {
      method: "GET",
      path: "/api/status",
      handler: () => ({
        ok: true,
        time: Date.now(),
        killSwitch: manager.risk.killSwitch(),
        liveTradingEnabled: config.liveTradingEnabled,
        keys: { demo: config.keys.demo.apiKey !== "", live: config.keys.live.apiKey !== "" },
        streams: Object.fromEntries(Object.entries(streams).map(([m, s]) => [m, { connected: s.connected, streams: s.streams }])),
        engine: { commit: ENGINE_INFO.commit, commitDate: ENGINE_INFO.commitDate, worktree: ENGINE_INFO.worktree, builtAt: ENGINE_INFO.builtAt },
        bots: store.listBots().map(botView),
      }),
    },
    {
      method: "GET",
      path: "/api/meta",
      handler: () => ({
        ok: true,
        strategies: engine.PRESET_STRATEGY_CATALOG,
        maTypes: engine.SUPPORTED_MA_TYPES,
        timeframes: Object.keys(TIMEFRAMES),
        accounts: ["paper", "demo", "live"],
        markets: ["spot", "futures"],
        maxLeverage: engine.MAX_PERP_LEVERAGE,
      }),
    },
    { method: "GET", path: "/api/engine", handler: () => ({ ok: true, engine: engineStatus(config.bistChartsDir) }) },

    // Bots.
    { method: "GET", path: "/api/bots", handler: () => ({ ok: true, bots: store.listBots().map(botView) }) },
    { method: "POST", path: "/api/bots", handler: async (ctx) => ({ ok: true, bot: await manager.createBot(ctx.body) }) },
    {
      method: "GET",
      path: "/api/bots/:id",
      handler: (ctx) => {
        const bot = manager.mustGet(num(ctx.params.id, "id"));
        return { ok: true, bot: botView(bot), labRequest: parseLabSettings(bot).request };
      },
    },
    { method: "PATCH", path: "/api/bots/:id", handler: async (ctx) => ({ ok: true, bot: await manager.updateBot(num(ctx.params.id, "id"), ctx.body) }) },
    {
      method: "DELETE",
      path: "/api/bots/:id",
      handler: (ctx) => {
        manager.deleteBot(num(ctx.params.id, "id"));
        return { ok: true };
      },
    },
    { method: "POST", path: "/api/bots/:id/start", handler: async (ctx) => ({ ok: true, bot: await manager.startBot(num(ctx.params.id, "id")) }) },
    { method: "POST", path: "/api/bots/:id/stop", handler: async (ctx) => ({ ok: true, bot: await manager.stopBot(num(ctx.params.id, "id"), { flatten: ctx.body.flatten === true }) }) },
    { method: "POST", path: "/api/bots/:id/resume", handler: async (ctx) => ({ ok: true, bot: await manager.resume(num(ctx.params.id, "id")) }) },
    {
      method: "POST",
      path: "/api/bots/:id/open",
      handler: async (ctx) => {
        const side = ctx.body.side;
        if (side !== "long" && side !== "short") throw new HttpError(400, "side must be long or short");
        const opt = (k) => {
          const v = ctx.body[k];
          if (v === undefined || v === null || v === "") return undefined;
          const n = Number(v);
          if (!(n > 0 && n < (k === "stopLossPct" ? 100 : 1000))) throw new HttpError(400, `${k} out of range`);
          return n;
        };
        const tradeId = await manager.manualOpen(num(ctx.params.id, "id"), side, { stopLossPct: opt("stopLossPct"), takeProfitPct: opt("takeProfitPct") });
        if (tradeId === null) throw new HttpError(409, "The entry was not placed; see the bot's events for why");
        return { ok: true, tradeId };
      },
    },
    { method: "POST", path: "/api/bots/:id/close", handler: async (ctx) => ({ ok: true, tradeId: await manager.manualClose(num(ctx.params.id, "id")) }) },
    { method: "GET", path: "/api/bots/:id/trades", handler: (ctx) => ({ ok: true, trades: store.trades({ botId: num(ctx.params.id, "id"), limit: Number(ctx.query.limit ?? 500) }) }) },
    { method: "GET", path: "/api/bots/:id/orders", handler: (ctx) => ({ ok: true, orders: store.orders({ botId: num(ctx.params.id, "id"), limit: Number(ctx.query.limit ?? 200) }) }) },
    { method: "GET", path: "/api/bots/:id/decisions", handler: (ctx) => ({ ok: true, decisions: store.decisions(num(ctx.params.id, "id"), Number(ctx.query.limit ?? 200)) }) },
    { method: "GET", path: "/api/bots/:id/equity", handler: (ctx) => ({ ok: true, equity: store.equity(num(ctx.params.id, "id"), Number(ctx.query.from ?? 0)) }) },
    { method: "GET", path: "/api/bots/:id/events", handler: (ctx) => ({ ok: true, events: store.events({ botId: num(ctx.params.id, "id"), limit: Number(ctx.query.limit ?? 200) }) }) },
    {
      method: "GET",
      path: "/api/bots/:id/candles",
      handler: (ctx) => {
        const bot = manager.mustGet(num(ctx.params.id, "id"));
        const from = Number(ctx.query.from ?? Math.floor(Date.now() / 1000) - 500 * TIMEFRAMES[bot.timeframe].sec);
        return { ok: true, candles: store.candles(bot.market, bot.symbol, bot.timeframe, from) };
      },
    },
    {
      method: "GET",
      path: "/api/bots/:id/backtest",
      handler: async (ctx) => {
        const bot = manager.mustGet(num(ctx.params.id, "id"));
        if (bot.anchor_time === null) throw new HttpError(409, "Start the bot once to fix its history window");
        const runner = await manager.ensureRunner(bot);
        const run = runner.backtestSinceAnchor();
        if (run === null) throw new HttpError(409, "Not enough bars stored yet");
        const sinceSec = Math.floor((bot.started_at ?? 0) / 1000);
        const engineTrades = run.trades.filter((t) => t.time >= sinceSec);
        const live = store.trades({ botId: bot.id, limit: 100_000 }).filter((t) => t.entry_time >= (bot.started_at ?? 0));
        return {
          ok: true,
          engineTrades,
          comparison: compareWithEngine(live, engineTrades, TIMEFRAMES[bot.timeframe].sec),
          engineEquity: run.equityCurveClose.map((e, i) => ({ time: run.timestamps[i] * 1000, equity: e })).filter((p) => p.time >= (bot.started_at ?? 0)),
        };
      },
    },

    // Account-wide.
    { method: "GET", path: "/api/trades", handler: (ctx) => ({ ok: true, trades: store.trades({ limit: Number(ctx.query.limit ?? 500) }) }) },
    { method: "GET", path: "/api/orders", handler: (ctx) => ({ ok: true, orders: store.orders({ limit: Number(ctx.query.limit ?? 200) }) }) },
    { method: "GET", path: "/api/events", handler: (ctx) => ({ ok: true, events: store.events({ afterId: Number(ctx.query.after ?? 0), limit: Number(ctx.query.limit ?? 200) }) }) },
    {
      method: "POST",
      path: "/api/kill",
      handler: async (ctx) => ({
        ok: true,
        killSwitch: await manager.setKillSwitch(ctx.body.active === true, { flatten: ctx.body.flatten === true, reason: String(ctx.body.reason ?? "").slice(0, 200) }),
      }),
    },
    { method: "GET", path: "/api/stream", stream: true, handler: () => null },
  ];
  return routes;
}

/** Server-sent events: every new event, plus a heartbeat every 25 s. */
export function sseHandler(events) {
  return (req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    const off = events.subscribe((e) => res.write(`id: ${e.id}\nevent: event\ndata: ${JSON.stringify(e)}\n\n`));
    const beat = setInterval(() => res.write(": beat\n\n"), 25_000);
    req.on("close", () => {
      off();
      clearInterval(beat);
    });
  };
}
