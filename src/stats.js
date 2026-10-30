// Performance figures of a bot's live trades and equity, and the comparison with the engine's backtest over the
// same bars.

/** Figures over closed trades (net P&L includes fees and funding) and the equity curve [{time, equity}]. */
export function tradeStats(trades, equity, capital) {
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
  const grossWin = sum(wins, (t) => t.pnl);
  const grossLoss = -sum(losses, (t) => t.pnl);
  let peak = capital;
  let maxDd = 0;
  for (const p of equity) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }
  const net = sum(closed, (t) => t.pnl);
  const last = equity.length > 0 ? equity[equity.length - 1].equity : capital;
  return {
    trades: closed.length,
    open: trades.length - closed.length,
    wins: wins.length,
    losses: losses.length,
    winRatePct: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    netPnl: net,
    returnPct: capital > 0 ? ((last - capital) / capital) * 100 : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
    avgWin: wins.length > 0 ? grossWin / wins.length : null,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : null,
    fees: sum(closed, (t) => (t.entry_fee ?? 0) + (t.exit_fee ?? 0)),
    funding: sum(closed, (t) => t.funding ?? 0),
    maxDrawdownPct: maxDd * 100,
    equity: last,
  };
}

/**
 * Live trades against the engine's trades since the bot started: pairs each live trade with the engine trade of
 * the same side whose entry bar is the one the live entry was decided on, and reports the price gaps.
 */
export function compareWithEngine(liveTrades, engineTrades, intervalSec) {
  const engineRoundTrips = [];
  let open = null;
  for (const t of engineTrades) {
    if (t.type === "ENTRY") open = t;
    else if (open) {
      engineRoundTrips.push({ side: open.side ?? "long", entryTime: open.time, entryPrice: open.price, exitTime: t.time, exitPrice: t.price, reason: t.reason, pnl: t.net_pnl ?? null });
      open = null;
    }
  }
  const rows = [];
  for (const lt of [...liveTrades].filter((t) => !t.manual).sort((a, b) => a.entry_time - b.entry_time)) {
    // The engine fills at the next bar's open: its entry time is the decision bar + one bar.
    const expectedEntry = lt.engine_bar_time !== null ? lt.engine_bar_time + intervalSec : null;
    const match = engineRoundTrips.find((e) => e.side === lt.side && e.entryTime === expectedEntry) ?? null;
    rows.push({
      liveTradeId: lt.id,
      side: lt.side,
      liveEntry: lt.entry_price,
      engineEntry: match?.entryPrice ?? null,
      entryGapPct: match ? ((lt.entry_price - match.entryPrice) / match.entryPrice) * 100 : null,
      liveExit: lt.exit_price,
      engineExit: match?.exitPrice ?? null,
      exitGapPct: match && lt.exit_price !== null && match.exitPrice ? ((lt.exit_price - match.exitPrice) / match.exitPrice) * 100 : null,
      liveReason: lt.exit_reason,
      engineReason: match?.reason ?? null,
      matched: match !== null,
    });
  }
  return rows;
}
