// Login, the request guards and the bot lifecycle through the HTTP API.
import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";
import { Clock, DeadWebSocket, FakeBinance, loadBars, noTimers, testConfig } from "./helpers.js";

const bars = loadBars("btcusdt-15m.json");

async function boot() {
  const clock = new Clock((bars[2000].time + 900) * 1000 + 3000);
  const fake = new FakeBinance({ clock, bars: { BTCUSDT: bars } });
  // The app's clock drives sessions too, so it keeps real time here; market data comes from the fake.
  const app = createApp(testConfig(), { fetchImpl: fake.fetch, WebSocketImpl: DeadWebSocket, now: clock.now, quiet: true, ...noTimers });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = "";
  const call = async (method, path, body, { csrf = true } = {}) => {
    const headers = { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-Requested-With": "binance-bot" } : {}) };
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  };
  return { app, call, clock, fake };
}

test("everything but login needs a session", async () => {
  const { app, call } = await boot();
  assert.equal((await call("GET", "/api/status")).status, 401);
  const page = await call("GET", "/");
  assert.equal(page.status, 302);
  assert.equal(page.headers.get("location"), "/login");
  assert.equal((await call("POST", "/api/login", { password: "whatever" })).status, 503, "no password set yet");
  await app.close();
});

test("login: wrong passwords are throttled, the right one opens a session", async () => {
  const { app, call } = await boot();
  app.auth.setPassword("correct horse battery");
  for (let k = 0; k < 5; k++) assert.equal((await call("POST", "/api/login", { password: "nope nope nope" })).status, 401);
  assert.equal((await call("POST", "/api/login", { password: "correct horse battery" })).status, 429, "sixth try in 15 minutes is refused");
  app.store.db.exec("DELETE FROM login_attempts");
  assert.equal((await call("POST", "/api/login", { password: "correct horse battery" }, { csrf: false })).status, 403, "mutations need the header");
  const ok = await call("POST", "/api/login", { password: "correct horse battery" });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  const status = await call("GET", "/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.json.engine.commit.length, 40);
  await call("POST", "/api/logout", {});
  assert.equal((await call("GET", "/api/status")).status, 401);
  await app.close();
});

test("bot lifecycle: refuse bad settings, create, start, open and close by hand, kill switch, stop", async () => {
  const { app, call, clock, fake } = await boot();
  app.auth.setPassword("correct horse battery");
  await call("POST", "/api/login", { password: "correct horse battery" });
  const bad = await call("POST", "/api/bots", { name: "x", account: "paper", market: "futures", symbol: "BTCUSDT", timeframe: "15m", strategy: { kind: "ma_cross", fast: 50, slow: 20 }, execution: { capital: 1000, takerFeePercent: 0.05 } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /Fast period must be less than slow/);
  const created = await call("POST", "/api/bots", {
    name: "paper kama", account: "paper", market: "futures", symbol: "BTCUSDT", timeframe: "15m", warmupBars: 500,
    strategy: { kind: "ma_cross", maType: "KAMA", fast: 9, slow: 21, perpDirection: "both", stopLossPct: 1 },
    execution: { capital: 1000, takerFeePercent: 0.05, makerFeePercent: 0.02, leverage: 2.5 },
  });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.bot.id;
  assert.equal((await call("POST", `/api/bots/${id}/start`, {})).json.bot.status, "running");
  const live = await call("POST", "/api/bots", { name: "live one", account: "live", market: "futures", symbol: "BTCUSDT", timeframe: "15m", strategy: { kind: "ma_cross" }, execution: { capital: 100, takerFeePercent: 0.05 } });
  const liveStart = await call("POST", `/api/bots/${live.json.bot.id}/start`, {});
  assert.equal(liveStart.status, 400);
  assert.match(liveStart.json.error, /Live trading is off/);

  const opened = await call("POST", `/api/bots/${id}/open`, { side: "short", stopLossPct: 2 });
  assert.equal(opened.status, 200, JSON.stringify(opened.json));
  const detail = await call("GET", `/api/bots/${id}`);
  assert.equal(detail.json.bot.position.side, "short");
  assert.equal(detail.json.bot.position.manual, 1);
  assert.ok(detail.json.bot.position.stop_price > detail.json.bot.position.entry_price);
  assert.equal(detail.json.labRequest.symbol, "BINANCE:BTCUSDT");
  assert.equal((await call("POST", `/api/bots/${id}/open`, { side: "long" })).status, 500, "one position per bot");
  clock.ms += 60_000;
  fake.priceOverride.set("BTCUSDT", detail.json.bot.position.entry_price * 0.99);
  assert.equal((await call("POST", `/api/bots/${id}/close`, {})).status, 200);
  const trades = (await call("GET", `/api/bots/${id}/trades`)).json.trades;
  assert.equal(trades[0].status, "closed");
  assert.ok(trades[0].pnl > 0, "a short closed 1 % lower made money");

  await call("POST", "/api/kill", { active: true, reason: "test" });
  assert.equal((await call("POST", `/api/bots/${id}/open`, { side: "long" })).status, 409);
  await call("POST", "/api/kill", { active: false });
  assert.equal((await call("PATCH", `/api/bots/${id}`, { strategy: { kind: "ma_cross", fast: 5, slow: 10 } })).status, 400, "running bots keep their strategy");
  assert.equal((await call("POST", `/api/bots/${id}/stop`, {})).json.bot.status, "stopped");
  const patched = await call("PATCH", `/api/bots/${id}`, { strategy: { kind: "ma_cross", maType: "EMA", fast: 5, slow: 10, perpDirection: "long_only" } });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(patched.json.bot.anchor_time, null, "a new strategy gets a new history window on its next start");
  const events = (await call("GET", "/api/events")).json.events;
  assert.ok(events.some((e) => e.type === "kill_switch_on"));
  await app.close();
});
