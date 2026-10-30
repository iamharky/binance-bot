// Owns every bot: creates, edits, starts and stops them, builds each one's account adapter, and routes closed bars
// from the candle feed to the bots that trade them.
//
// One bot per account, market and symbol may be active (running or halted): on futures the exchange nets one
// position per symbol, and on spot two bots would sell each other's coins.
import { BinanceRest } from "../binance/rest.js";
import { ConfigError, parseLabSettings, TIMEFRAMES, venueRules } from "../engine.js";
import { FuturesExchange } from "../exchange/futures.js";
import { PaperExchange } from "../exchange/paper.js";
import { SpotExchange } from "../exchange/spot.js";
import { BotRunner } from "./runner.js";
import { parseRisk } from "./risk.js";

const ACCOUNTS = ["paper", "demo", "live"];
const ACTIVE = new Set(["running", "halted"]);

export class BotManager {
  constructor({ store, events, risk, market, feed, config, fetchImpl = globalThis.fetch, now = () => Date.now() }) {
    this.store = store;
    this.events = events;
    this.risk = risk;
    this.market = market;
    this.feed = feed;
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.runners = new Map();
    this.restClients = new Map();
    feed.on("bar", (b) => this.onBar(b));
  }

  /** Resumes every bot that was active when the process stopped. */
  async init() {
    for (const bot of this.store.listBots()) {
      if (!ACTIVE.has(bot.status)) continue;
      try {
        const runner = await this.ensureRunner(bot);
        this.feed.subscribe(bot.market, bot.symbol, bot.timeframe);
        await runner.start();
        if (bot.status === "halted") this.store.updateBot(bot.id, { status: "halted", halted_reason: bot.halted_reason });
      } catch (e) {
        this.store.updateBot(bot.id, { status: "halted", halted_reason: `could not resume: ${e.message}` });
        this.events.error("bot_resume_failed", `${bot.name} could not resume: ${e.message}`, { botId: bot.id });
      }
    }
  }

  validate(input, existing = null) {
    const name = String(input.name ?? existing?.name ?? "").trim();
    if (!name || name.length > 60) throw new ConfigError("Name is required (at most 60 characters)", "name");
    const account = input.account ?? existing?.account ?? "paper";
    if (!ACCOUNTS.includes(account)) throw new ConfigError("Account must be paper, demo or live", "account");
    const market = input.market ?? existing?.market;
    const symbol = String(input.symbol ?? existing?.symbol ?? "").toUpperCase();
    const timeframe = input.timeframe ?? existing?.timeframe;
    const strategy = input.strategy ?? existing?.strategy;
    const execution = { ...(existing?.execution ?? {}), ...(input.execution ?? {}) };
    if (execution.equityFraction !== undefined && !(execution.equityFraction > 0.5 && execution.equityFraction <= 1)) {
      throw new ConfigError("equityFraction must be in (0.5, 1]", "execution.equityFraction");
    }
    if (execution.marginType !== undefined && execution.marginType !== "ISOLATED" && execution.marginType !== "CROSSED") {
      throw new ConfigError("marginType must be ISOLATED or CROSSED", "execution.marginType");
    }
    if (execution.workingType !== undefined && execution.workingType !== "CONTRACT_PRICE" && execution.workingType !== "MARK_PRICE") {
      throw new ConfigError("workingType must be CONTRACT_PRICE or MARK_PRICE", "execution.workingType");
    }
    const lab = parseLabSettings({ market, symbol, timeframe, strategy, execution });
    let risk;
    try {
      risk = parseRisk({ ...(existing?.risk ?? {}), ...(input.risk ?? {}) });
    } catch (e) {
      throw new ConfigError(e.message, "risk");
    }
    const warmupBars = input.warmupBars ?? existing?.warmup_bars ?? 1000;
    if (!Number.isInteger(warmupBars) || warmupBars < 50 || warmupBars > 20_000) throw new ConfigError("warmupBars must be an integer from 50 to 20000", "warmupBars");
    // The market decides spot or perp; the stored strategy keeps only what the owner chose.
    const { positionMode: _mode, ...stored } = lab.strategy;
    return { name, account, market, symbol, timeframe, strategy: stored, execution, risk, warmupBars, lab };
  }

  async createBot(input) {
    const v = this.validate(input);
    await this.market.symbolInfo(v.market, v.symbol);
    const bot = this.store.insertBot(v);
    this.events.info("bot_created", `Created ${bot.name}: ${bot.account} ${bot.market} ${bot.symbol} ${bot.timeframe} ${bot.strategy.kind}`, { botId: bot.id });
    return bot;
  }

  async updateBot(id, patch) {
    const bot = this.mustGet(id);
    const tradingChange = ["account", "market", "symbol", "timeframe", "strategy", "execution", "warmupBars"].some((k) => patch[k] !== undefined);
    if (tradingChange && ACTIVE.has(bot.status)) throw new ConfigError("Stop the bot before changing what or how it trades");
    if (tradingChange && this.store.openTrade(id)) throw new ConfigError("Close the bot's position before changing what or how it trades");
    const v = this.validate(patch, bot);
    if (v.symbol !== bot.symbol || v.market !== bot.market) await this.market.symbolInfo(v.market, v.symbol);
    const fields = { name: v.name, risk: v.risk };
    if (tradingChange) {
      Object.assign(fields, {
        account: v.account, market: v.market, symbol: v.symbol, timeframe: v.timeframe, strategy: v.strategy,
        execution: v.execution, warmup_bars: v.warmupBars, anchor_time: null, last_bar_time: null, started_at: null,
      });
      this.runners.delete(id);
    }
    const updated = this.store.updateBot(id, fields);
    this.runners.get(id)?.refresh();
    this.events.info("bot_updated", `Updated ${updated.name}`, { botId: id, data: { fields: Object.keys(patch) } });
    return updated;
  }

  deleteBot(id) {
    const bot = this.mustGet(id);
    if (ACTIVE.has(bot.status)) throw new ConfigError("Stop the bot before deleting it");
    if (this.store.openTrade(id)) throw new ConfigError("Close the bot's position before deleting it");
    this.runners.delete(id);
    this.store.deleteBot(id);
    this.events.info("bot_deleted", `Deleted ${bot.name}`, { botId: id });
  }

  async startBot(id) {
    const bot = this.mustGet(id);
    if (ACTIVE.has(bot.status)) return bot;
    if (bot.account === "live" && !this.config.liveTradingEnabled) {
      throw new ConfigError("Live trading is off. Set LIVE_TRADING_ENABLED=1 in .env and restart to allow live bots");
    }
    for (const other of this.store.listBots()) {
      if (other.id !== id && ACTIVE.has(other.status) && other.account === bot.account && other.market === bot.market && other.symbol === bot.symbol) {
        throw new ConfigError(`${other.name} already trades ${bot.symbol} on the ${bot.account} ${bot.market} account`);
      }
    }
    const runner = await this.ensureRunner(bot);
    this.feed.subscribe(bot.market, bot.symbol, bot.timeframe);
    try {
      await runner.start();
    } catch (e) {
      this.feed.unsubscribe(bot.market, bot.symbol, bot.timeframe);
      this.events.error("bot_start_failed", `${bot.name} could not start: ${e.message}`, { botId: id });
      throw e;
    }
    return this.store.getBot(id);
  }

  async stopBot(id, { flatten = false } = {}) {
    const bot = this.mustGet(id);
    const runner = this.runners.get(id) ?? (flatten ? await this.ensureRunner(bot) : null);
    if (runner) await runner.stop({ flatten });
    else this.store.updateBot(id, { status: "stopped" });
    if (ACTIVE.has(bot.status)) this.feed.unsubscribe(bot.market, bot.symbol, bot.timeframe);
    return this.store.getBot(id);
  }

  async resume(id) {
    const bot = this.mustGet(id);
    if (bot.status !== "halted") throw new ConfigError("Only a halted bot can be resumed");
    this.risk.orderSucceeded(id);
    this.store.updateBot(id, { status: "running", halted_reason: null });
    this.runners.get(id)?.refresh();
    this.events.info("bot_resumed", `${bot.name} resumed`, { botId: id });
    return this.store.getBot(id);
  }

  async manualOpen(id, side, opts) {
    const runner = await this.ensureRunner(this.mustGet(id));
    return runner.manualOpen(side, opts);
  }

  async manualClose(id) {
    const runner = await this.ensureRunner(this.mustGet(id));
    return runner.manualClose();
  }

  async setKillSwitch(active, { flatten = false, reason = "" } = {}) {
    const k = this.risk.setKillSwitch(active, reason);
    this.events.emit(active ? "warn" : "info", active ? "kill_switch_on" : "kill_switch_off", `Kill switch ${active ? "ON" : "off"}${reason ? `: ${reason}` : ""}${active && flatten ? ", flattening every bot" : ""}`);
    if (active && flatten) {
      for (const bot of this.store.listBots()) {
        if (!this.store.openTrade(bot.id)) continue;
        try {
          const runner = await this.ensureRunner(bot);
          await runner.enqueue(async () => {
            runner.refresh();
            const price = await this.market.price(bot.market, bot.symbol);
            if (runner.exchange.kind === "paper") runner.exchange.setReferencePrice(bot.symbol, price);
            return runner.closePosition("KILL_SWITCH", { price, manual: true });
          });
        } catch (e) {
          this.events.error("flatten_failed", `${bot.name} could not be flattened: ${e.message}`, { botId: bot.id });
        }
      }
    }
    return k;
  }

  mustGet(id) {
    const bot = this.store.getBot(id);
    if (!bot) throw new ConfigError(`No bot ${id}`);
    return bot;
  }

  rest(market, env) {
    const key = `${market}:${env}`;
    let r = this.restClients.get(key);
    if (!r) {
      const keys = this.config.keys[env];
      r = new BinanceRest({ market, env, apiKey: keys.apiKey, apiSecret: keys.apiSecret, fetch: this.fetch, now: this.now });
      this.restClients.set(key, r);
    }
    return r;
  }

  async exchangeFor(bot, info) {
    const lab = parseLabSettings(bot);
    if (bot.account === "paper") return new PaperExchange({ takerFeeRate: lab.execution.takerFeeRate, now: this.now });
    const rest = this.rest(bot.market, bot.account);
    if (!rest.hasKeys) throw new ConfigError(`No ${bot.account} API key: set BINANCE_${bot.account.toUpperCase()}_API_KEY and _SECRET in .env`);
    if (bot.market === "futures") return new FuturesExchange({ rest, quoteAsset: info.quoteAsset ?? info.marginAsset ?? "USDT" });
    return new SpotExchange({ rest, baseAsset: () => info.baseAsset, quoteAsset: info.quoteAsset ?? "USDT" });
  }

  async ensureRunner(bot) {
    let runner = this.runners.get(bot.id);
    if (runner) {
      runner.refresh();
      return runner;
    }
    const info = await this.market.symbolInfo(bot.market, bot.symbol);
    const venue = venueRules(bot.market, info);
    const exchange = await this.exchangeFor(bot, info);
    runner = new BotRunner({ bot, store: this.store, events: this.events, risk: this.risk, exchange, market: this.market, feed: this.feed, venue, now: this.now });
    this.runners.set(bot.id, runner);
    return runner;
  }

  onBar({ market, symbol, timeframe, time }) {
    for (const runner of this.runners.values()) {
      const b = runner.bot;
      if (b.market !== market || b.symbol !== symbol || b.timeframe !== timeframe) continue;
      runner.onBar(time).catch((e) => this.events.error("bar_failed", `${b.name} at ${new Date(time * 1000).toISOString()}: ${e.message}`, { botId: b.id, data: { stack: e.stack } }));
    }
  }

  timeframes() {
    return Object.keys(TIMEFRAMES);
  }
}
