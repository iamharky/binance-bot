# binance-bot

Trades the strategies you optimise in bist-charts' Strategy Lab on Binance spot and USD-M futures, with the
**same engine**: `engine/engine.mjs` is bist-charts' own quant code (`src/lib/quant`), bundled unchanged by
`npm run sync-engine`. A bot's settings are parsed by bist-charts' backtest parser, so a setting the Lab refuses is
refused here with the Lab's message, and a bot replays exactly the Lab run its settings describe.

Node.js 22.13 or newer, no runtime dependencies (SQLite, HTTP, WebSocket and fetch are built into Node).

## Start on the Mac

```sh
cd ~/Desktop/binance-bot
cp .env.example .env          # then put your Binance Demo Trading API key and secret in .env
npm run cli -- set-password   # the password for the web page (10 characters or more)
npm start                     # then open http://127.0.0.1:8787
```

Demo keys: log in to Binance, open **Demo Trading**, then API Management
(demo.binance.com/en/my/settings/api-management). The bot uses the same demo key for demo spot and demo futures
(UNVERIFIED: if futures calls are refused with an invalid-key error, Binance wants separate keys).

Stop it with Ctrl+C. Bots that were running resume on the next `npm start` (they catch up on the bars they
missed, but never jump into a trade the engine opened while the bot was down; see "How a bot trades").

## Make a bot

**New bot** on the web page. The quickest way is **Paste settings from the Strategy Lab**: paste the run's
request JSON (`{"symbol": "BINANCE:BTCUSDT", "timeframe": "15m", "strategy": {...}, ...}`) and the form fills
in: `BINANCE:` ids become futures bots, `CRYPTO:` ids spot bots. Or fill the form by hand: symbol, timeframe,
strategy and its parameters (for example KAMA 84/115, Long & Short), take profit / stop loss / exit after bars,
capital, leverage, fees.

Accounts:

- **paper**: no orders anywhere; fills are simulated on live Binance prices. No keys needed.
- **demo**: real orders on Binance Demo Trading (demo-api.binance.com, demo-fapi.binance.com).
- **live**: real money. Refuses to start unless `.env` has `LIVE_TRADING_ENABLED=1` and live keys.

A new bot is stopped; press **Start**. Futures bots need the account in **One-way Mode** (they refuse to start in
Hedge Mode) and use isolated margin unless a bot says otherwise. One active bot per account, market and symbol (Binance nets one futures
position per symbol, and two spot bots would sell each other's coins).

## How a bot trades

Every closed candle (the bot subscribes to Binance's live kline stream and backfills over REST after a gap):

1. The engine runs over the bars since the bot's history anchor (its warm-up window) and says what the strategy
   does at this close (`decideAtClose`, added to bist-charts for this bot: the same ledger the Lab's backtest
   writes, proven equal on every bar of 116 strategy setups).
2. The bot reconciles with the exchange: a stop, target or liquidation the exchange filled closes the bot's
   trade at the exchange's fill prices. A position the bot did not open halts the bot.
3. It acts: an exit closes at market, an entry opens at market. The engine fills at the next candle's open,
   which on Binance prints right after this close, so both happen at the same moment.
4. Right after an entry fill, the stop-loss and take-profit go **on the exchange** at the engine's levels from
   the real fill price (futures: conditional algo orders with closePosition; spot: one OCO sell). If they cannot
   be placed, the position is closed at once rather than left unprotected.

Decisions use **live** Binance market data whatever the account, so a demo bot decides on the same candles the Lab
backtests. Demo fills happen on the demo exchange, whose prices are close to live but not identical.

The bot follows the engine but never chases it: if the engine entered while the bot could not (it was stopped,
an entry was refused, you closed by hand), the bot waits for the engine's next entry.

**Size:** each bot has its own capital, which grows and shrinks with its realised P&L, exactly like the
backtest's equity. Futures entries are sized all-in at the leverage, as the engine sizes them, using 98 % of that
capital so a moving fill price never overshoots (`execution.equityFraction`, 0.5 to 1).

**Decimal leverage (2.5x):** Binance accepts whole leverage only. The bot sets ceil(L) (3x) on the exchange, sizes
the position at L (2.5x of the capital) and, in isolated margin, adds margin until it equals notional / L, so the
liquidation price is the one 2.5x gives.

**Manual trades:** Open long / Open short / Close position on a bot. A manual position keeps the stop and target
you give it (or the strategy's), and the engine's exits leave it alone.

## Safety

- **Kill switch** (top right, or `npm run cli -- kill`): no bot opens anything until it is released; exits and
  stops keep working. Turning it on can also close every position at once.
- **Per-bot limits:** max daily loss %, max drawdown %, order failures in a row. Breaking one halts the bot: no new
  entries, exits keep running, optionally the position is closed. **Resume** lets it trade again.
- The strategy's own kill switch and loss-streak breaker (Lab settings) act through the engine, as in the backtest.
- Secrets only in `.env`, never in the database or logs. The page needs the password; sessions last 7 days;
  5 wrong passwords in 15 minutes lock that address out for the rest of the window.

## Updating the engine

When bist-charts' quant code changes, rebuild the bundle from your bist-charts checkout (`BIST_CHARTS_DIR`,
default `../bist-charts`):

```sh
npm install          # once: esbuild, used only by sync-engine
npm run sync-engine  # bundles bist-charts at its last commit (HEAD); --worktree takes uncommitted files too
```

It prints the golden strategies whose trades changed with the new engine. `engine/engine.json` records the commit;
the page shows it, and `GET /api/engine` lists newer bist-charts commits that touch the engine. Restart the bot
after a sync; running bots keep trading on the engine they started with until then.

## Tests

```sh
npm test
```

- `paper-parity`: a paper bot fed 1,200 real BTCUSDT 15m candles one by one makes the engine's backtest trades
  (same bars, sides, exit reasons), with and without 2.5x stop and target.
- `futures`: a demo futures bot against a simulated Binance account: One-way Mode check, isolated margin, 3x on the
  exchange for 2.5x, algo stop and target at the engine's levels, exchange-side exits booked, kill switch, a foreign
  position halting the bot, a failed stop placement closing the position.
- `engine`: the bundle is the one `engine.json` names and still trades the golden strategies identically; settings
  are refused with bist-charts' messages.
- `api`: login, throttling, the request guard and a whole bot lifecycle through the HTTP API.

## Files

- `src/`: `main.js` (server), `app.js` (wiring), `engine.js` (the only door to the engine), `bot/` (runner,
  manager, candle feed, risk), `exchange/` (futures, spot, paper), `binance/` (REST, market data, streams),
  `server/` (HTTP, API, login), `db.js` (SQLite), `cli.js`.
- `public/`: the web page (plain JavaScript).
- `engine/`: the bundled engine, its stamp and golden results; `scripts/sync-engine.mjs` builds them.
- `data/bot.db`: everything the bot records (bots, candles, decisions, orders, trades, equity, events). Back it up.

## Not yet

Step 3: the full control interface. Step 4: the VPS (HTTPS in front, `COOKIE_SECURE=1`, `TRUST_PROXY=1`,
auto-restart, backups) and Telegram alerts. Pine strategies from the Lab are not supported yet; presets are.
