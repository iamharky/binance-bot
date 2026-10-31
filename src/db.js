// SQLite storage (node:sqlite, one file in DATA_DIR). Times: candle and bar times are epoch seconds (the
// engine's unit); every wall-clock column (created_at, entry_time, event time, ...) is epoch milliseconds.
// Schema changes are additive: a new version appends to MIGRATIONS, never edits an applied step.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const MIGRATIONS = [
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
     last_seen INTEGER NOT NULL, ip TEXT, user_agent TEXT);
   CREATE TABLE login_attempts (ip TEXT NOT NULL, time INTEGER NOT NULL, ok INTEGER NOT NULL);
   CREATE INDEX login_attempts_ip ON login_attempts (ip, time);
   CREATE TABLE bots (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     account TEXT NOT NULL CHECK (account IN ('paper', 'demo', 'live')),
     market TEXT NOT NULL CHECK (market IN ('spot', 'futures')),
     symbol TEXT NOT NULL,
     timeframe TEXT NOT NULL,
     strategy TEXT NOT NULL,
     execution TEXT NOT NULL,
     risk TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped', 'running', 'halted')),
     halted_reason TEXT,
     warmup_bars INTEGER NOT NULL DEFAULT 1000,
     anchor_time INTEGER,
     started_at INTEGER,
     last_bar_time INTEGER,
     engine_commit TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL);
   CREATE TABLE candles (market TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL, time INTEGER NOT NULL,
     open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL,
     PRIMARY KEY (market, symbol, interval, time)) WITHOUT ROWID;
   CREATE TABLE decisions (id INTEGER PRIMARY KEY, bot_id INTEGER NOT NULL, bar_time INTEGER NOT NULL,
     position_at_close INTEGER NOT NULL, target_position INTEGER NOT NULL, actions TEXT NOT NULL,
     engine_equity REAL, created_at INTEGER NOT NULL, UNIQUE (bot_id, bar_time));
   CREATE TABLE orders (id INTEGER PRIMARY KEY, bot_id INTEGER, client_id TEXT UNIQUE, exchange_id TEXT,
     account TEXT NOT NULL, market TEXT NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, type TEXT NOT NULL,
     purpose TEXT NOT NULL, qty REAL, price REAL, trigger_price REAL, status TEXT NOT NULL, avg_price REAL,
     filled_qty REAL, fee REAL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
   CREATE INDEX orders_bot ON orders (bot_id, created_at);
   CREATE TABLE trades (id INTEGER PRIMARY KEY, bot_id INTEGER NOT NULL, side TEXT NOT NULL CHECK (side IN ('long', 'short')),
     qty REAL NOT NULL, leverage REAL NOT NULL DEFAULT 1, entry_time INTEGER NOT NULL, entry_price REAL NOT NULL,
     entry_fee REAL NOT NULL DEFAULT 0, entry_reason TEXT NOT NULL, engine_bar_time INTEGER,
     stop_price REAL, take_profit_price REAL, protective TEXT, exit_time INTEGER, exit_price REAL, exit_fee REAL, exit_reason TEXT,
     funding REAL NOT NULL DEFAULT 0, pnl REAL, manual INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL CHECK (status IN ('open', 'closed')));
   CREATE INDEX trades_bot ON trades (bot_id, status, entry_time);
   CREATE TABLE equity (bot_id INTEGER NOT NULL, time INTEGER NOT NULL, equity REAL NOT NULL, engine_equity REAL,
     PRIMARY KEY (bot_id, time)) WITHOUT ROWID;
   CREATE TABLE events (id INTEGER PRIMARY KEY, time INTEGER NOT NULL, level TEXT NOT NULL, bot_id INTEGER,
     type TEXT NOT NULL, message TEXT NOT NULL, data TEXT);
   CREATE INDEX events_time ON events (time);`,
  // The limit entry order a bot keeps working on the exchange (runner.js "Limit entries"), JSON or null.
  `ALTER TABLE bots ADD COLUMN working_entry TEXT;`,
];

export function openDb(dataDir) {
  let path = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true });
    path = join(dataDir, "bot.db");
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get();
  let version = row ? row.version : 0;
  if (!row) db.exec("INSERT INTO schema_version (version) VALUES (0)");
  for (; version < MIGRATIONS.length; version++) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]);
      db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    });
  }
  return new Store(db);
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const J = (v) => JSON.stringify(v);
const P = (s) => (s == null ? null : JSON.parse(s));

function botFromRow(r) {
  if (!r) return null;
  return { ...r, strategy: P(r.strategy), execution: P(r.execution), risk: P(r.risk), working_entry: P(r.working_entry ?? null) };
}

/** Every query the app makes, in one place. */
export class Store {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    return tx(this.db, fn);
  }

  // Settings (JSON values).
  getSetting(key, dflt = null) {
    const r = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return r ? P(r.value) : dflt;
  }

  setSetting(key, value) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, J(value));
  }

  // Bots.
  listBots() {
    return this.db.prepare("SELECT * FROM bots ORDER BY id").all().map(botFromRow);
  }

  getBot(id) {
    return botFromRow(this.db.prepare("SELECT * FROM bots WHERE id = ?").get(id));
  }

  insertBot(b, now = Date.now()) {
    const r = this.db
      .prepare(
        `INSERT INTO bots (name, account, market, symbol, timeframe, strategy, execution, risk, warmup_bars, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(b.name, b.account, b.market, b.symbol, b.timeframe, J(b.strategy), J(b.execution), J(b.risk), b.warmupBars, now, now);
    return this.getBot(Number(r.lastInsertRowid));
  }

  updateBot(id, fields, now = Date.now()) {
    const cols = [];
    const vals = [];
    for (const [k, v] of Object.entries(fields)) {
      cols.push(`${k} = ?`);
      vals.push(k === "strategy" || k === "execution" || k === "risk" || (k === "working_entry" && v !== null) ? J(v) : v);
    }
    cols.push("updated_at = ?");
    vals.push(now);
    this.db.prepare(`UPDATE bots SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
    return this.getBot(id);
  }

  deleteBot(id) {
    this.db.prepare("DELETE FROM bots WHERE id = ?").run(id);
  }

  // Candles.
  upsertCandles(market, symbol, interval, candles) {
    const st = this.db.prepare(
      `INSERT INTO candles (market, symbol, interval, time, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (market, symbol, interval, time) DO UPDATE SET open = excluded.open, high = excluded.high,
       low = excluded.low, close = excluded.close, volume = excluded.volume`,
    );
    tx(this.db, () => {
      for (const c of candles) st.run(market, symbol, interval, c.time, c.open, c.high, c.low, c.close, c.volume ?? 0);
    });
  }

  candles(market, symbol, interval, fromTime, toTime = Number.MAX_SAFE_INTEGER) {
    return this.db
      .prepare(
        `SELECT time, open, high, low, close, volume FROM candles WHERE market = ? AND symbol = ? AND interval = ?
         AND time >= ? AND time <= ? ORDER BY time`,
      )
      .all(market, symbol, interval, fromTime, toTime);
  }

  lastCandleTime(market, symbol, interval) {
    const r = this.db.prepare("SELECT MAX(time) AS t FROM candles WHERE market = ? AND symbol = ? AND interval = ?").get(market, symbol, interval);
    return r?.t ?? null;
  }

  // Decisions.
  insertDecision(botId, d, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO decisions (bot_id, bar_time, position_at_close, target_position, actions, engine_equity, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bot_id, bar_time) DO NOTHING`,
      )
      .run(botId, d.barTime, d.positionAtClose, d.targetPosition, J(d.actions), d.equityAtClose, now);
  }

  decisions(botId, limit = 200) {
    return this.db
      .prepare("SELECT * FROM decisions WHERE bot_id = ? ORDER BY bar_time DESC LIMIT ?")
      .all(botId, limit)
      .map((r) => ({ ...r, actions: P(r.actions) }));
  }

  // Orders.
  insertOrder(o, now = Date.now()) {
    const r = this.db
      .prepare(
        `INSERT INTO orders (bot_id, client_id, account, market, symbol, side, type, purpose, qty, price, trigger_price, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(o.botId ?? null, o.clientId, o.account, o.market, o.symbol, o.side, o.type, o.purpose, o.qty ?? null, o.price ?? null, o.triggerPrice ?? null, o.status ?? "new", now, now);
    return Number(r.lastInsertRowid);
  }

  updateOrder(id, fields, now = Date.now()) {
    const cols = Object.keys(fields).map((k) => `${k} = ?`);
    this.db.prepare(`UPDATE orders SET ${cols.join(", ")}, updated_at = ? WHERE id = ?`).run(...Object.values(fields), now, id);
  }

  orders({ botId = null, limit = 200 } = {}) {
    if (botId === null) return this.db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ?").all(limit);
    return this.db.prepare("SELECT * FROM orders WHERE bot_id = ? ORDER BY id DESC LIMIT ?").all(botId, limit);
  }

  // Trades (the bot's own positions, open and closed).
  openTrade(botId) {
    const r = this.db.prepare("SELECT * FROM trades WHERE bot_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(botId);
    return r ? { ...r, protective: P(r.protective) } : null;
  }

  insertTrade(t) {
    const r = this.db
      .prepare(
        `INSERT INTO trades (bot_id, side, qty, leverage, entry_time, entry_price, entry_fee, entry_reason, engine_bar_time,
         stop_price, take_profit_price, manual, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(t.botId, t.side, t.qty, t.leverage ?? 1, t.entryTime, t.entryPrice, t.entryFee ?? 0, t.entryReason, t.engineBarTime ?? null,
        t.stopPrice ?? null, t.takeProfitPrice ?? null, t.manual ? 1 : 0);
    return Number(r.lastInsertRowid);
  }

  updateTrade(id, fields) {
    const cols = Object.keys(fields).map((k) => `${k} = ?`);
    const vals = Object.entries(fields).map(([k, v]) => (k === "protective" ? J(v) : v));
    this.db.prepare(`UPDATE trades SET ${cols.join(", ")} WHERE id = ?`).run(...vals, id);
  }

  trades({ botId = null, limit = 500 } = {}) {
    const rows =
      botId === null
        ? this.db.prepare("SELECT * FROM trades ORDER BY entry_time DESC LIMIT ?").all(limit)
        : this.db.prepare("SELECT * FROM trades WHERE bot_id = ? ORDER BY entry_time DESC LIMIT ?").all(botId, limit);
    return rows.map((r) => ({ ...r, protective: P(r.protective) }));
  }

  /** Net P&L of the bot's closed trades (fees and funding included). */
  realizedPnl(botId) {
    return this.db.prepare("SELECT COALESCE(SUM(pnl), 0) AS p FROM trades WHERE bot_id = ? AND status = 'closed'").get(botId).p;
  }

  // Equity.
  insertEquity(botId, time, equity, engineEquity) {
    this.db
      .prepare(
        `INSERT INTO equity (bot_id, time, equity, engine_equity) VALUES (?, ?, ?, ?)
         ON CONFLICT (bot_id, time) DO UPDATE SET equity = excluded.equity, engine_equity = excluded.engine_equity`,
      )
      .run(botId, time, equity, engineEquity);
  }

  equity(botId, fromTime = 0) {
    return this.db.prepare("SELECT time, equity, engine_equity FROM equity WHERE bot_id = ? AND time >= ? ORDER BY time").all(botId, fromTime);
  }

  // Events.
  insertEvent(e) {
    const r = this.db
      .prepare("INSERT INTO events (time, level, bot_id, type, message, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.time, e.level, e.botId ?? null, e.type, e.message, e.data == null ? null : J(e.data));
    return Number(r.lastInsertRowid);
  }

  events({ botId = null, afterId = 0, limit = 200 } = {}) {
    const rows =
      botId === null
        ? this.db.prepare("SELECT * FROM events WHERE id > ? ORDER BY id DESC LIMIT ?").all(afterId, limit)
        : this.db.prepare("SELECT * FROM events WHERE bot_id = ? AND id > ? ORDER BY id DESC LIMIT ?").all(botId, afterId, limit);
    return rows.map((r) => ({ ...r, data: P(r.data) }));
  }

  // Sessions and login throttling.
  insertSession(s) {
    this.db.prepare("INSERT INTO sessions (id, created_at, expires_at, last_seen, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)").run(s.id, s.createdAt, s.expiresAt, s.createdAt, s.ip, s.userAgent);
  }

  getSession(id) {
    return this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) ?? null;
  }

  touchSession(id, now) {
    this.db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(now, id);
  }

  deleteSession(id) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  deleteAllSessions() {
    this.db.prepare("DELETE FROM sessions").run();
  }

  recordLogin(ip, time, ok) {
    this.db.prepare("INSERT INTO login_attempts (ip, time, ok) VALUES (?, ?, ?)").run(ip, time, ok ? 1 : 0);
    this.db.prepare("DELETE FROM login_attempts WHERE time < ?").run(time - 24 * 3600 * 1000);
  }

  failedLogins(ip, since) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND time >= ? AND ok = 0").get(ip, since).n;
  }
}
