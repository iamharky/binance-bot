// The control page: bots, their positions and results, manual trades, the kill switch and the live activity
// feed. Plain DOM, no framework; every value from the server is set as text, never as HTML.

const $ = (sel) => document.querySelector(sel);
// `|| 0` turns a rounded -0 into 0, so a tiny negative gap never prints as "-0.000".
const fmt = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : (Number(n.toFixed(d)) || 0).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const price = (n) => (n === null || n === undefined ? "–" : n.toLocaleString("en-US", { maximumFractionDigits: 8 }));
const signed = (n, d = 2) => (n === null || n === undefined || !Number.isFinite(n) ? "–" : `${n > 0 ? "+" : ""}${fmt(n, d)}`);
const tone = (n) => (n > 0 ? "pos" : n < 0 ? "neg" : "");
const time = (ms) => (ms ? new Date(ms).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "–");

/** h("div", {class: "x", onclick}, child, "text") */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(method === "GET" ? {} : { "X-Requested-With": "binance-bot" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    location.replace("/login");
    throw new Error("Logged out");
  }
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!res.ok || json.ok === false) throw Object.assign(new Error(json.error ?? `HTTP ${res.status}`), { field: json.field });
  return json;
}

function banner(message, kind = "error") {
  const b = $("#banner");
  b.textContent = message;
  b.className = `banner ${kind}`;
  b.hidden = false;
  clearTimeout(banner.timer);
  banner.timer = setTimeout(() => (b.hidden = true), 8000);
}

async function act(fn, done) {
  try {
    const out = await fn();
    if (done) banner(done, "ok");
    await refresh();
    return out;
  } catch (e) {
    banner(e.message);
    return null;
  }
}

const state = { status: null, meta: null, selected: null, tab: "trades", detail: null };

// ---------------------------------------------------------------------------
// Top bar
// ---------------------------------------------------------------------------

function renderTop() {
  const s = state.status;
  $("#engine").textContent = `Engine ${s.engine.commit.slice(0, 8)}${s.engine.worktree ? " (uncommitted)" : ""} · ${s.engine.commitDate?.slice(0, 10) ?? ""}`;
  const streams = Object.entries(s.streams).map(([m, x]) => h("span", { class: `pill ${x.connected ? "ok" : x.streams.length ? "bad" : ""}`, title: x.streams.join(", ") || "no subscriptions" }, `${m} ${x.connected ? "live" : x.streams.length ? "reconnecting" : "idle"}`));
  $("#streams").replaceChildren(...streams, s.liveTradingEnabled ? h("span", { class: "pill bad" }, "LIVE TRADING ON") : h("span", { class: "pill" }, "live trading off"));
  const kill = $("#kill");
  kill.textContent = s.killSwitch.active ? "Kill switch ON · release" : "Kill switch";
  kill.className = s.killSwitch.active ? "danger active" : "danger";
  kill.title = s.killSwitch.active ? s.killSwitch.reason || "" : "Stop every bot from opening positions";
}

$("#kill").addEventListener("click", async () => {
  if (state.status.killSwitch.active) return act(() => api("POST", "/api/kill", { active: false }), "Kill switch released");
  const flatten = confirm("Turn the kill switch on: no bot opens anything.\n\nOK also closes every open position now; Cancel only blocks new entries.");
  const reason = prompt("Reason (optional)", "") ?? "";
  return act(() => api("POST", "/api/kill", { active: true, flatten, reason }), flatten ? "Kill switch on, closing every position" : "Kill switch on");
});

$("#logout").addEventListener("click", async () => {
  await api("POST", "/api/logout", {}).catch(() => {});
  location.replace("/login");
});

// ---------------------------------------------------------------------------
// Bot list
// ---------------------------------------------------------------------------

function strategyText(bot) {
  const s = bot.strategy;
  const meta = state.meta?.strategies.find((x) => x.kind === s.kind);
  let out = s.kind === "ma_cross" ? `${s.maType ?? "EMA"} ${s.fast}/${s.slow}` : meta?.usesFastSlow ? `${meta.defaultLabel.split(" (")[0]} ${s.fast}/${s.slow}` : meta?.defaultLabel.split(" (")[0] ?? s.kind;
  if (bot.market === "futures") out += ` · ${{ both: "L&S", long_only: "long", short_only: "short" }[s.perpDirection ?? "both"]}`;
  if (s.takeProfitPct) out += ` · TP ${s.takeProfitPct}%`;
  if (s.stopLossPct) out += ` · SL ${s.stopLossPct}%`;
  if (s.exitAfterBars) out += ` · ${s.exitAfterBars} bars`;
  return out;
}

function renderBots() {
  const list = state.status.bots;
  if (list.length === 0) {
    $("#bot-list").replaceChildren(h("p", { class: "muted" }, "No bots yet."));
    return;
  }
  $("#bot-list").replaceChildren(
    ...list.map((b) =>
      h(
        "button",
        { type: "button", class: `bot-row ${state.selected === b.id ? "selected" : ""}`, onclick: () => select(b.id) },
        h("div", { class: "bot-row-top" }, h("strong", {}, b.name), h("span", { class: `pill status-${b.status}` }, b.status)),
        h("div", { class: "small" }, `${b.symbol} · ${b.timeframe} · ${b.market}${b.market === "futures" ? ` ${b.execution.leverage ?? 1}x` : ""} · ${b.account}`),
        h("div", { class: "small muted" }, strategyText(b)),
        h(
          "div",
          { class: "small bot-row-figs" },
          b.position ? h("span", { class: `pill side-${b.position.side}` }, b.position.side) : h("span", { class: "muted" }, "flat"),
          h("span", { class: tone(b.stats.netPnl) }, `${signed(b.stats.netPnl)} USDT`),
          h("span", { class: tone(b.stats.returnPct) }, `${signed(b.stats.returnPct)} %`),
          h("span", { class: "muted" }, `${b.stats.trades} trades`),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// Bot detail
// ---------------------------------------------------------------------------

async function select(id) {
  state.selected = id;
  state.detail = null;
  renderBots();
  await loadDetail();
}

async function loadDetail() {
  const id = state.selected;
  if (id === null) return;
  try {
    const [bot, tab] = await Promise.all([api("GET", `/api/bots/${id}`), loadTab(id, state.tab)]);
    if (state.selected !== id) return;
    state.detail = { ...bot, tabData: tab };
    renderDetail();
  } catch (e) {
    banner(e.message);
  }
}

async function loadTab(id, tab) {
  switch (tab) {
    case "trades":
      return (await api("GET", `/api/bots/${id}/trades?limit=200`)).trades;
    case "engine":
      return api("GET", `/api/bots/${id}/backtest`).catch((e) => ({ error: e.message }));
    case "orders":
      return (await api("GET", `/api/bots/${id}/orders?limit=200`)).orders;
    case "decisions":
      return (await api("GET", `/api/bots/${id}/decisions?limit=200`)).decisions;
    case "events":
      return (await api("GET", `/api/bots/${id}/events?limit=200`)).events;
    case "equity":
      return (await api("GET", `/api/bots/${id}/equity`)).equity;
    default:
      return null;
  }
}

function stat(label, value, cls = "") {
  return h("div", { class: "stat" }, h("div", { class: "muted small" }, label), h("div", { class: `stat-value ${cls}` }, value));
}

function table(head, rows) {
  if (rows.length === 0) return h("p", { class: "muted" }, "Nothing yet.");
  return h("div", { class: "table-wrap" }, h("table", {}, h("thead", {}, h("tr", {}, head.map((x) => h("th", {}, x)))), h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c) => (c instanceof Node ? h("td", {}, c) : h("td", {}, c ?? "–"))))))));
}

function equityChart(points, enginePoints) {
  const all = [...points.map((p) => p.equity), ...enginePoints.map((p) => p.equity)].filter(Number.isFinite);
  if (points.length < 2 || all.length < 2) return h("p", { class: "muted" }, "The equity curve appears after a few bars.");
  const W = 640;
  const H = 180;
  const t0 = Math.min(points[0].time, enginePoints[0]?.time ?? Infinity);
  const t1 = Math.max(points[points.length - 1].time, enginePoints[enginePoints.length - 1]?.time ?? -Infinity);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v) => H - 6 - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 12);
  const path = (ps) => ps.map((p, i) => `${i ? "L" : "M"}${x(p.time).toFixed(1)},${y(p.equity).toFixed(1)}`).join("");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "chart");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Equity: bot and engine");
  for (const [d, cls] of [[path(enginePoints), "line-engine"], [path(points), "line-bot"]]) {
    if (!d) continue;
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    p.setAttribute("class", cls);
    svg.append(p);
  }
  return h("div", {}, svg, h("div", { class: "small legend" }, h("span", { class: "key bot" }, "Bot"), h("span", { class: "key engine" }, "Engine backtest of the same bars, rebased to the bot's start"), h("span", { class: "muted" }, `${fmt(lo)} – ${fmt(hi)} USDT`)));
}

function renderTab(id, tab, data) {
  switch (tab) {
    case "trades":
      return table(
        ["Side", "Entry", "Entry price", "Exit", "Exit price", "Reason", "Qty", "Fees", "Funding", "P&L"],
        data.map((t) => [
          h("span", { class: `pill side-${t.side}` }, t.manual ? `${t.side} (manual)` : t.side),
          time(t.entry_time),
          price(t.entry_price),
          t.status === "open" ? h("span", { class: "pill" }, "open") : time(t.exit_time),
          price(t.exit_price),
          t.exit_reason ?? t.entry_reason,
          price(t.qty),
          fmt((t.entry_fee ?? 0) + (t.exit_fee ?? 0), 4),
          fmt(t.funding, 4),
          h("span", { class: tone(t.pnl) }, signed(t.pnl)),
        ]),
      );
    case "engine": {
      if (data.error) return h("p", { class: "muted" }, data.error);
      const rows = data.comparison;
      const matched = rows.filter((r) => r.matched).length;
      return h(
        "div",
        {},
        h("p", { class: "small" }, `${matched} of ${rows.length} bot trades match an engine trade on the same bar and side. The engine backtest of the same bars made ${data.engineTrades.filter((t) => t.type === "ENTRY").length} entries.`),
        table(
          ["Side", "Bot entry", "Engine entry", "Gap %", "Bot exit", "Engine exit", "Gap %", "Bot reason", "Engine reason"],
          rows.map((r) => [r.side, price(r.liveEntry), price(r.engineEntry), fmt(r.entryGapPct, 3), price(r.liveExit), price(r.engineExit), fmt(r.exitGapPct, 3), r.liveReason, r.engineReason ?? (r.matched ? "open" : "no match")]),
        ),
      );
    }
    case "orders":
      return table(
        ["Time", "Purpose", "Side", "Type", "Qty", "Trigger", "Avg price", "Fee", "Status"],
        data.map((o) => [time(o.created_at), o.purpose, o.side, o.type, price(o.qty), price(o.trigger_price), price(o.avg_price), fmt(o.fee, 4), o.error ? h("span", { class: "neg", title: o.error }, o.status) : o.status]),
      );
    case "decisions":
      return table(
        ["Bar (open time)", "Position at close", "Target", "Actions", "Engine equity"],
        data.map((d) => [time(d.bar_time * 1000), d.position_at_close, d.target_position, d.actions.map((a) => `${a.type} ${a.side} @ ${a.at} (${a.reason})`).join("; ") || "–", fmt(d.engine_equity)]),
      );
    case "events":
      return table(["Time", "Level", "Type", "Message"], data.map((e) => [time(e.time), h("span", { class: `lvl-${e.level}` }, e.level), e.type, e.message]));
    case "equity":
      return h("div", { id: `equity-${id}` }, equityChart(data, []));
    default:
      return null;
  }
}

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const b = d.bot;
  const s = b.stats;
  const pos = b.position;
  const running = b.status === "running";
  const halted = b.status === "halted";
  const actions = h(
    "div",
    { class: "actions wrap" },
    b.status === "stopped" && h("button", { class: "primary", onclick: () => act(() => api("POST", `/api/bots/${b.id}/start`, {}), `${b.name} started`) }, "Start"),
    halted && h("button", { class: "primary", onclick: () => act(() => api("POST", `/api/bots/${b.id}/resume`, {}), `${b.name} resumed`) }, "Resume"),
    b.status !== "stopped" && h("button", { onclick: () => act(() => api("POST", `/api/bots/${b.id}/stop`, {}), `${b.name} stopped`) }, "Stop"),
    b.status !== "stopped" && pos && h("button", { class: "danger", onclick: () => confirm(`Stop ${b.name} and close its ${pos.side} position at market?`) && act(() => api("POST", `/api/bots/${b.id}/stop`, { flatten: true }), `${b.name} stopped and closed`) }, "Stop & close"),
    !pos && h("button", { class: "long", onclick: () => manualOpen(b, "long") }, "Open long"),
    !pos && b.market === "futures" && h("button", { class: "short", onclick: () => manualOpen(b, "short") }, "Open short"),
    pos && h("button", { class: "danger", onclick: () => confirm(`Close the ${pos.side} position of ${b.name} at market?`) && act(() => api("POST", `/api/bots/${b.id}/close`, {}), "Position closed") }, "Close position"),
    b.status === "stopped" && h("button", { class: "ghost", onclick: () => openForm(b) }, "Edit"),
    b.status === "stopped" && !pos && h("button", { class: "ghost", onclick: () => deleteBot(b) }, "Delete"),
  );
  const tabs = ["trades", "engine", "equity", "orders", "decisions", "events"];
  const tabNames = { trades: "Trades", engine: "Bot vs engine", equity: "Equity", orders: "Orders", decisions: "Decisions", events: "Events" };
  const children = [
    h("div", { class: "panel-head" }, h("h2", {}, b.name), h("span", { class: `pill status-${b.status}` }, b.status)),
    halted && h("p", { class: "banner error inline" }, `Halted: ${b.halted_reason ?? ""}. Exits still run; Resume allows new entries again.`),
    h("p", { class: "small" }, `${b.symbol} · ${b.timeframe} · ${b.market}${b.market === "futures" ? ` ${b.execution.leverage ?? 1}x ${b.execution.marginType ?? "ISOLATED"}` : ""} · ${b.account} account · ${strategyText(b)}`),
    h("p", { class: "small muted" }, `Capital ${fmt(b.execution.capital)} USDT · taker ${b.execution.takerFeePercent ?? "–"} % · last bar ${b.last_bar_time ? time(b.last_bar_time * 1000) : "–"} · engine ${b.engine_commit?.slice(0, 8) ?? "–"} · Lab id ${d.labRequest.symbol}`),
    actions,
    pos &&
      h(
        "div",
        { class: `position side-${pos.side}` },
        h("strong", {}, `${pos.side.toUpperCase()} ${price(pos.qty)} @ ${price(pos.entry_price)}`),
        h("span", { class: "small" }, ` since ${time(pos.entry_time)}${pos.manual ? " (manual)" : ""} · stop ${price(pos.stop_price)} · target ${price(pos.take_profit_price)}`),
      ),
    h(
      "div",
      { class: "stats" },
      stat("Equity", `${fmt(s.equity)} USDT`),
      stat("Net P&L (closed)", `${signed(s.netPnl)} USDT`, tone(s.netPnl)),
      stat("Return", `${signed(s.returnPct)} %`, tone(s.returnPct)),
      stat("Trades", `${s.trades}${s.open ? ` + ${s.open} open` : ""}`),
      stat("Win rate", s.winRatePct === null ? "–" : `${fmt(s.winRatePct, 1)} %`),
      stat("Profit factor", fmt(s.profitFactor)),
      stat("Max drawdown", `${fmt(s.maxDrawdownPct)} %`),
      stat("Fees · funding", `${fmt(s.fees)} · ${signed(s.funding)}`),
    ),
    h("div", { class: "tabs", role: "tablist" }, tabs.map((t) => h("button", { role: "tab", "aria-selected": String(state.tab === t), class: state.tab === t ? "tab active" : "tab", onclick: () => switchTab(t) }, tabNames[t]))),
    h("div", { class: "tab-body" }, renderTab(b.id, state.tab, d.tabData)),
  ];
  $("#detail").replaceChildren(...children.filter(Boolean));
  if (state.tab === "equity") {
    api("GET", `/api/bots/${b.id}/backtest`)
      .then((bt) => {
        // The engine's run starts at the bot's history anchor, so its equity at the bot's start differs from the
        // bot's capital; both size all-in, so rescaling the engine curve to the bot's first point compares returns.
        const first = d.tabData[0];
        const e0 = bt.engineEquity.find((p) => p.time >= (first?.time ?? 0));
        const k = first && e0 && e0.equity > 0 ? first.equity / e0.equity : 1;
        $(`#equity-${b.id}`)?.replaceChildren(equityChart(d.tabData, bt.engineEquity.map((p) => ({ time: p.time, equity: p.equity * k }))));
      })
      .catch(() => {});
  }
}

async function deleteBot(b) {
  if (!confirm(`Delete ${b.name}? Its trade log goes too.`)) return;
  try {
    await api("DELETE", `/api/bots/${b.id}`);
  } catch (e) {
    banner(e.message);
    return;
  }
  state.selected = null;
  state.detail = null;
  $("#detail").replaceChildren(h("p", { class: "muted" }, "Select a bot, or create one."));
  banner(`${b.name} deleted`, "ok");
  await refresh();
}

async function switchTab(tab) {
  state.tab = tab;
  await loadDetail();
}

async function manualOpen(bot, side) {
  const sl = prompt(`Open ${side} on ${bot.symbol} at market.\n\nStop loss % (empty = the strategy's: ${bot.strategy.stopLossPct ?? "none"})`, "");
  if (sl === null) return;
  const tp = prompt(`Take profit % (empty = the strategy's: ${bot.strategy.takeProfitPct ?? "none"})`, "");
  if (tp === null) return;
  await act(() => api("POST", `/api/bots/${bot.id}/open`, { side, stopLossPct: sl.trim() || undefined, takeProfitPct: tp.trim() || undefined }), `${side} opened`);
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------

const dialog = $("#bot-dialog");
const form = $("#bot-form");
const F = form.elements;
let editing = null;

function fillSelect(sel, options) {
  sel.replaceChildren(...options.map(([v, label]) => h("option", { value: v }, label)));
}

function syncFormVisibility() {
  const kind = F.kind.value;
  const meta = state.meta.strategies.find((s) => s.kind === kind);
  const perp = F.market.value === "futures";
  for (const el of form.querySelectorAll("[data-for]")) {
    const f = el.dataset.for;
    el.hidden = (f === "ma" && !meta?.usesMaType) || (f === "fastslow" && !meta?.usesFastSlow) || (f === "perp" && !perp);
  }
}

F.kind.addEventListener("change", () => {
  const meta = state.meta.strategies.find((s) => s.kind === F.kind.value);
  if (meta?.usesFastSlow) {
    F.fast.value = meta.defaultFast;
    F.slow.value = meta.defaultSlow;
  }
  if (meta?.usesMaType) F.maType.value = meta.defaultMaType;
  syncFormVisibility();
});
F.market.addEventListener("change", syncFormVisibility);

function setForm(v) {
  for (const [k, val] of Object.entries(v)) {
    const el = form.elements[k];
    if (!el || val === undefined) continue;
    if (el.type === "checkbox") el.checked = val === true;
    else el.value = val === null ? "" : String(val);
  }
  syncFormVisibility();
}

function openForm(bot = null) {
  editing = bot;
  form.reset();
  $("#bot-form-error").hidden = true;
  $("#bot-form-title").textContent = bot ? `Edit ${bot.name}` : "New bot";
  if (bot) {
    setForm({ name: bot.name, account: bot.account, market: bot.market, symbol: bot.symbol, timeframe: bot.timeframe, warmupBars: bot.warmup_bars, ...bot.strategy, ...bot.execution, ...bot.risk });
  } else {
    setForm({ timeframe: "15m", kind: "ma_cross", maType: "KAMA", fast: 9, slow: 21 });
  }
  dialog.showModal();
}

const numOrNull = (v) => (v === "" || v === null || v === undefined ? null : Number(v));

function readForm() {
  const f = form.elements;
  const perp = f.market.value === "futures";
  const meta = state.meta.strategies.find((s) => s.kind === f.kind.value);
  const strategy = { kind: f.kind.value, exitOnSignal: f.exitOnSignal.checked };
  if (meta?.usesMaType) strategy.maType = f.maType.value;
  if (meta?.usesFastSlow) {
    strategy.fast = numOrNull(f.fast.value);
    strategy.slow = numOrNull(f.slow.value);
  }
  if (perp) strategy.perpDirection = f.perpDirection.value;
  for (const k of ["takeProfitPct", "stopLossPct", "exitAfterBars", "stopTradingBelowPct", "maxLossStreak"]) {
    const v = numOrNull(f[k].value);
    if (v !== null && v !== 0) strategy[k] = v;
  }
  const execution = { capital: numOrNull(f.capital.value), takerFeePercent: numOrNull(f.takerFeePercent.value) };
  if (perp) {
    execution.leverage = numOrNull(f.leverage.value) ?? 1;
    execution.makerFeePercent = numOrNull(f.makerFeePercent.value);
    execution.maintenanceMarginPercent = numOrNull(f.maintenanceMarginPercent.value) ?? 0;
  }
  const risk = {
    maxDailyLossPct: numOrNull(f.maxDailyLossPct.value),
    maxDrawdownPct: numOrNull(f.maxDrawdownPct.value),
    maxConsecutiveFailures: numOrNull(f.maxConsecutiveFailures.value) ?? 5,
    flattenOnHalt: f.flattenOnHalt.checked,
  };
  return {
    name: f.name.value.trim(),
    account: f.account.value,
    market: f.market.value,
    symbol: f.symbol.value.trim().toUpperCase(),
    timeframe: f.timeframe.value,
    warmupBars: numOrNull(f.warmupBars.value) ?? 1000,
    strategy,
    execution,
    risk,
  };
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#bot-form-error");
  err.hidden = true;
  try {
    const body = readForm();
    const out = editing ? await api("PATCH", `/api/bots/${editing.id}`, body) : await api("POST", "/api/bots", body);
    dialog.close();
    banner(editing ? "Saved" : `${out.bot.name} created (stopped: press Start)`, "ok");
    state.selected = out.bot.id;
    await refresh();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$("#bot-cancel").addEventListener("click", () => dialog.close());
$("#new-bot").addEventListener("click", () => openForm(null));

// A Strategy Lab request ({symbol: "BINANCE:BTCUSDT", timeframe, strategy, initialCapital, ...}) fills the form.
$("#import-apply").addEventListener("click", () => {
  const err = $("#bot-form-error");
  err.hidden = true;
  try {
    const raw = JSON.parse($("#import-json").value);
    const req = raw.request ?? raw;
    const m = /^(BINANCE|CRYPTO):([A-Z0-9]+)$/.exec(String(req.symbol ?? ""));
    if (!m) throw new Error("The request's symbol must be BINANCE:<pair> (futures) or CRYPTO:<pair> (spot)");
    const s = req.strategy ?? {};
    if (s.kind === "pine") throw new Error("Pine strategies are not supported by the bot yet; use a preset strategy");
    const market = m[1] === "BINANCE" ? "futures" : "spot";
    setForm({
      market,
      symbol: m[2],
      timeframe: req.timeframe,
      name: F.name.value || `${m[2]} ${req.timeframe} ${s.maType ?? ""} ${s.fast ?? ""}/${s.slow ?? ""}`.replace(/\s+/g, " ").trim(),
      kind: s.kind,
      maType: s.maType,
      fast: s.fast,
      slow: s.slow,
      perpDirection: s.perpDirection ?? "both",
      takeProfitPct: s.takeProfitPct ?? null,
      stopLossPct: s.stopLossPct ?? null,
      exitAfterBars: s.exitAfterBars ?? null,
      exitOnSignal: s.exitOnSignal ?? true,
      stopTradingBelowPct: s.stopTradingBelowPct ?? null,
      maxLossStreak: s.maxLossStreak ?? null,
      capital: req.initialCapital,
      takerFeePercent: req.takerFeePercent ?? req.commissionPercent,
      makerFeePercent: req.makerFeePercent,
      leverage: req.leverage ?? 1,
      maintenanceMarginPercent: req.maintenanceMarginPercent ?? 0,
    });
    banner("Form filled from the Lab settings; check them, then Save", "ok");
  } catch (ex) {
    err.textContent = ex instanceof SyntaxError ? "That is not valid JSON" : ex.message;
    err.hidden = false;
  }
});

// ---------------------------------------------------------------------------
// Activity feed and refresh
// ---------------------------------------------------------------------------

function eventItem(e) {
  const bot = state.status?.bots.find((b) => b.id === e.bot_id);
  return h("li", { class: `lvl-${e.level}` }, h("span", { class: "muted small" }, time(e.time)), bot ? h("span", { class: "small tag" }, bot.name) : null, h("span", {}, e.message));
}

async function loadEvents() {
  const { events } = await api("GET", "/api/events?limit=100");
  $("#events").replaceChildren(...events.map(eventItem));
}

let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 400);
}

async function refresh() {
  try {
    state.status = await api("GET", "/api/status");
    renderTop();
    renderBots();
    if (state.selected !== null && state.status.bots.some((b) => b.id === state.selected)) await loadDetail();
  } catch (e) {
    banner(e.message);
  }
}

function connectStream() {
  const es = new EventSource("/api/stream");
  es.addEventListener("event", (msg) => {
    const e = JSON.parse(msg.data);
    $("#events").prepend(eventItem(e));
    while ($("#events").children.length > 200) $("#events").lastChild.remove();
    refreshSoon();
  });
  es.onerror = () => {
    // The browser reconnects by itself; a lost session shows up on the next refresh.
  };
}

state.meta = await api("GET", "/api/meta");
fillSelect(F.timeframe, state.meta.timeframes.map((t) => [t, t]));
fillSelect(F.kind, state.meta.strategies.map((s) => [s.kind, s.defaultLabel]));
fillSelect(F.maType, state.meta.maTypes.map((t) => [t, t]));
await refresh();
await loadEvents();
connectStream();
setInterval(refresh, 15_000);
