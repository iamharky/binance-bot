// The event log: every decision, order, fill, refusal and halt goes to the events table, to stdout as one JSON
// line, and to live subscribers (the UI's event stream, Telegram later).
export class EventLog {
  constructor(store, { now = () => Date.now(), quiet = false } = {}) {
    this.store = store;
    this.now = now;
    this.quiet = quiet;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(level, type, message, { botId = null, data = null } = {}) {
    const e = { time: this.now(), level, botId, type, message, data };
    e.id = this.store.insertEvent(e);
    if (!this.quiet) {
      const line = JSON.stringify({ t: new Date(e.time).toISOString(), level, bot: botId, type, msg: message, ...(data ? { data } : {}) });
      (level === "error" ? console.error : console.log)(line);
    }
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // A broken subscriber never stops trading.
      }
    }
    return e;
  }

  info(type, message, opts) {
    return this.emit("info", type, message, opts);
  }

  warn(type, message, opts) {
    return this.emit("warn", type, message, opts);
  }

  error(type, message, opts) {
    return this.emit("error", type, message, opts);
  }
}
