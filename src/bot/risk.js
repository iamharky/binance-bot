// Risk rules. Two levels:
// - the global kill switch (settings.killSwitch): while on, no bot opens anything; turning it on with
//   flatten closes every bot's position too;
// - per bot (bot.risk): maxDailyLossPct (equity against the UTC day's first equity), maxDrawdownPct (against the
//   peak equity since the bot started) and maxConsecutiveFailures (order errors in a row). Breaking one halts the
//   bot: no new entries, while exits (engine exits, stops, manual closes) keep working until it is flat.
// The engine's own kill switch and loss-streak breaker (strategy.stopTradingBelowPct / maxLossStreak) are part
// of the strategy and act through the engine's decisions, exactly as in the backtest.

export const DEFAULT_RISK = { maxDailyLossPct: null, maxDrawdownPct: null, maxConsecutiveFailures: 5, flattenOnHalt: false };

export function parseRisk(raw = {}) {
  const out = { ...DEFAULT_RISK };
  const pct = (k) => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") return;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n >= 100) throw new Error(`${k} must be a percent between 0 and 100`);
    out[k] = n;
  };
  pct("maxDailyLossPct");
  pct("maxDrawdownPct");
  if (raw.maxConsecutiveFailures !== undefined && raw.maxConsecutiveFailures !== null) {
    const n = Number(raw.maxConsecutiveFailures);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("maxConsecutiveFailures must be an integer from 1 to 100");
    out.maxConsecutiveFailures = n;
  }
  if (raw.flattenOnHalt !== undefined) out.flattenOnHalt = raw.flattenOnHalt === true;
  return out;
}

export class RiskGuard {
  constructor(store) {
    this.store = store;
    this.failures = new Map();
  }

  killSwitch() {
    return this.store.getSetting("killSwitch", { active: false });
  }

  setKillSwitch(active, reason = "") {
    const v = { active, reason, at: Date.now() };
    this.store.setSetting("killSwitch", v);
    return v;
  }

  /** Null when the bot may open a position, else why not. */
  entryRefusal(bot) {
    const k = this.killSwitch();
    if (k.active) return `kill switch on${k.reason ? `: ${k.reason}` : ""}`;
    if (bot.status === "halted") return `bot halted: ${bot.halted_reason ?? "risk limit"}`;
    if (bot.status !== "running") return `bot is ${bot.status}`;
    return null;
  }

  orderFailed(botId) {
    const n = (this.failures.get(botId) ?? 0) + 1;
    this.failures.set(botId, n);
    return n;
  }

  orderSucceeded(botId) {
    this.failures.set(botId, 0);
  }

  failuresOf(botId) {
    return this.failures.get(botId) ?? 0;
  }

  /**
   * The limit a bot's equity history breaks, or null. `history` is [{time (ms), equity}] oldest first, ending
   * with the current equity.
   */
  equityBreach(bot, history) {
    const r = bot.risk ?? DEFAULT_RISK;
    if (history.length === 0) return null;
    const now = history[history.length - 1];
    if (r.maxDrawdownPct) {
      let peak = -Infinity;
      for (const p of history) peak = Math.max(peak, p.equity);
      if (peak > 0 && (peak - now.equity) / peak >= r.maxDrawdownPct / 100) {
        return `drawdown ${(((peak - now.equity) / peak) * 100).toFixed(2)}% from the peak ${peak.toFixed(2)} reached the ${r.maxDrawdownPct}% limit`;
      }
    }
    if (r.maxDailyLossPct) {
      const dayStart = Math.floor(now.time / 86_400_000) * 86_400_000;
      const first = history.find((p) => p.time >= dayStart);
      const prevDay = [...history].reverse().find((p) => p.time < dayStart);
      const anchor = prevDay ?? first;
      if (anchor && anchor.equity > 0 && (anchor.equity - now.equity) / anchor.equity >= r.maxDailyLossPct / 100) {
        return `daily loss ${(((anchor.equity - now.equity) / anchor.equity) * 100).toFixed(2)}% reached the ${r.maxDailyLossPct}% limit`;
      }
    }
    return null;
  }
}
