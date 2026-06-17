# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Systematic Binance USDT-M perpetual futures bot (long/short, R-based risk), reverse-engineered from a friend's profitable 1h trend-pullback bot. The bot lives at the REPO ROOT (restructured 2026-06-12; the former poli_bot workspace sibling was removed — its code is in git history, its data/keys archived at ~/Documents/Mike/poli_bot_archive_2026-06-12.tar.gz). Run all npm scripts from the root. The design, build history, current config, and the 2026-06 improvements are all in [README.md](README.md). The bot is feature-complete (M0–M9) and **LIVE on mainnet at tiny size since 2026-06-10** (1% risk, notional cap 50% of equity per leg, 45-symbol static universe) — treat every change as touching real money.

## Commands

| Command | Purpose | DB |
|---|---|---|
| `npm run collect` | Download/cache 1h klines for the universe (uses the API). `TIMEFRAME=15m` → 15m candles (needed once for LIVE_SIM). | `binance.sqlite` |
| `npm run collect-funding` | Download 8h funding history (for accurate backtest costs). | `binance.sqlite` |
| `npm run universe` | Snapshot the current top-N by volume into a pinned list. | `binance.sqlite` |
| `npm run backtest` | Replay candles through the engine; prints win%, expectancy, PF, maxDD, daily-PnL distribution, by-close-reason, net of fees+funding. `TRAIN_END=YYYY-MM-DD` does a walk-forward. **To compare with live, ALWAYS add `LIVE_SIM=true BACKTEST_SYMBOLS=env`** (guardian overlay + live universe + live sizing caps — see README §5); the bare default replays ALL DB symbols with no guardian and flatters results. | `binance.sqlite` |
| `npm run optimize` | Walk-forward grid search over playbook knobs (select on TRAIN, report TEST). Pure engine by design — validate winners with LIVE_SIM afterwards. | `binance.sqlite` |
| `npm run sweep` | Walk-forward sweep over ATR_MULT × TP profile × time-stops × ADX (the levers optimize misses); honors `LIVE_SIM` + `BACKTEST_SYMBOLS`. | `binance.sqlite` |
| `npm run testnet` | **Forward-test** — runs the live engine against the test venue (real orders, no real money): a full tick hourly on candle close + an intra-minute guardian in between. | `testnet.sqlite` |
| `npm run live` | Real money on mainnet. Refuses unless `ALLOW_LIVE=true` **and** `CONFIRM_LIVE=true`. | `live.sqlite` |
| `npm run dashboard:testnet` / `dashboard:live` | Read-only ops dashboard (localhost:8787 / :8788). | testnet / live |
| `npm run account` / `account:live` | Print balance + positions + tracked positions for that venue. | testnet / live |
| `npm run flatten` / `flatten:live` | Emergency: close ALL open positions (reduceOnly market) + cancel resting orders + clear tracked positions. `flatten:live` needs `ALLOW_LIVE=true`. | testnet / live |
| `npm run test-order` | Round-trip order check — open a min-size market position, confirm the fill, close it, end flat. | testnet |
| `npm run backup` | One-off SQLite backup → `data/backups/` (named per source DB). | `binance.sqlite` |
| `npm run smoke` | M1 gate — read market data without keys. | — |
| `npm run typecheck` | `tsc --noEmit`. The only static check — no test runner, no linter. | — |

Runtime: Node ≥20, ESM (`"type": "module"`), TypeScript via `tsx`. Imports use `.js` suffixes on `.ts` sources (ESM + Bundler resolution). Preserve this.

**Engine env flags** (prefix any `testnet`/`live` run): `RUN_NOW=true` (tick immediately then hourly), `ONESHOT=true` (one tick, exit), `DRY_RUN=true` (simulate, no orders, paper equity — see warning below), `NO_STREAM=true` (skip the user-data WS), `SKIP_COUNTDOWN=true`. Strategy/risk overrides: `RISK_USDT`, `ADX_MIN`, `TRAIL_MULT`, `COOLDOWN`, `TAKE1`, `TAKE2`, `PLAYBOOKS`, `UNIVERSE_MODE`, etc. Guardian overrides: `MONITOR_ENABLED`, `MONITOR_INTERVAL_MIN`, `MONITOR_REVERSAL_MODE` (off|warn|exit), `MONITOR_REVERSAL_TF`, `MONITOR_SUMMARY_MIN`, `HEARTBEAT_HOURS` (tick-done Telegram every N h, 0 = off), `ENTRY_ALIGN` (skip entries the exit-mode guardian would instantly kill; same flag drives the LIVE_SIM replay).

> ⚠️ **Never run `DRY_RUN` against `testnet.sqlite`/`live.sqlite`.** It writes simulated (`-paper`) trades into the venue DB and pollutes the dashboard. Use a throwaway `DB_PATH=/tmp/x.sqlite` for dry-run sanity checks.

## Architecture

### One shared logic path (the whole point)
The decisive design rule: **build the strategy logic once, reuse it for backtest / testnet / live.** The pure decision functions are shared verbatim:
- `detect()` per playbook ([src/playbooks/](src/playbooks/)) — entry signals.
- `sizePosition()` ([src/risk/sizing.ts](src/risk/sizing.ts)) — R-based sizing; notional derived from the stop.
- `manageOnCandle()` ([src/risk/manage.ts](src/risk/manage.ts)) — the TP ladder / breakeven / trailing / health-close exit machine.

[src/backtest/runner.ts](src/backtest/runner.ts) calls them in a vectorized timeline replay; [src/engine/loop.ts](src/engine/loop.ts) calls the *same* functions once per real closed candle. **If you change exit/sizing/signal logic, both paths must stay in sync** — keep it in the shared functions, not duplicated. (The journaling helpers `settleFill`/`buildClosedTrade` are exported from `loop.ts` and reused by `deps.ts` reconcile to avoid a third copy.)

### The live engine ([src/engine/loop.ts](src/engine/loop.ts))
`runScheduled` runs a **dual cadence in one loop** (single process → no DB concurrency): a **full `runTick`** a short buffer after each 1h candle close, and a fast **guardian pass** every `MONITOR_INTERVAL_MIN` (default 1m) in between. The full `runTick` = one bar of the backtest loop:
1. **Manage** open positions: charge funding (paper only), **reconcile against the exchange** (`broker.getPosition` is the source of truth — if the exchange shows flat, the protective stop fired → journal the close; tracked qty is synced to exchange truth *bidirectionally*), then `manageOnCandle` → execute exits via the broker.
2. **Kill switch**: block new entries if today's drawdown ≥ `MAX_DAILY_LOSS_PCT`.
3. **Scan** the universe for entries (respecting cooldown + `MAX_OPEN_POSITIONS`).
4. Snapshot equity, stamp `engine:lastTickTime`, daily backup.

Only **closed** candles are used (drop the in-progress one) — matches the backtest, no lookahead. Open positions persist in `live_positions` so a restart reconciles instead of orphaning trades; on startup `reconcileLive` aligns the DB with exchange truth.

**The guardian (`monitorOpenPositions`) is a LIVE-ONLY safety overlay — NOT modelled by the backtest.** It never opens positions and never runs the TP ladder; per open position it (A) **enforces the bot-managed stop on the live mark** if breached (closes immediately as `GUARDIAN_STOP` instead of waiting up to an hour — critical on the demo venue, which rejects the resting STOP_MARKET so the stop is otherwise only enforced on the hourly tick), and (B) in `warn`/`exit` mode checks a faster-TF (`MONITOR_REVERSAL_TF`, default 15m) EMA50/EMA200 flip against the position and flags (warn) or closes (`REVERSAL_CLOSE`) it — but only while `!tp2Hit`, so a locked trailing runner is never cut short. Layer A is backtest-neutral (the backtest already assumes intra-candle stop fills); Layer B is a deliberate live-only deviation, journalled with its own close reasons so its impact can be measured.

### Execution model (testnet/live)
Market entry, **plus a resting `closePosition` STOP_MARKET on the exchange as a safety net** (protects the position while the bot sleeps between hourly ticks). The bot manages the TP ladder + trailing stop on candle close via reduceOnly market orders, and cancels/replaces the protective stop when `pos.stop` moves. Assumes **one-way** position mode (enforced at startup). The exit price for a stop fired offline is recovered from `lastFill`.

**Conditional orders moved to the Algo endpoint (2025-12-09):** Binance migrated STOP_MARKET / TAKE_PROFIT_MARKET / TRAILING_STOP_MARKET / STOP / TAKE_PROFIT OFF `/fapi/v1/order` (which now returns **-4120 STOP_ORDER_SWITCH_ALGO**) onto **`POST /fapi/v1/algoOrder`** (`algoType=CONDITIONAL`, param is `triggerPrice` not `stopPrice`, `clientAlgoId` not `newClientOrderId`, returns `algoId`). `placeProtectiveStop` uses this; cancel via `cancelAlgoOrder` → **`DELETE /fapi/v1/algoOrder`** (`{symbol, algoId}`); list open ones via `getOpenAlgoOrders` → `GET /fapi/v1/openAlgoOrders`. (NB: the Algo cancel/query paths differ from the docs' summarized names — these are the verified working ones.) This affects **mainnet too**, not just demo — the old code's protective stop was silently broken on real money until this migration. Plain MARKET entries/exits still use `/fapi/v1/order` (not conditional, unaffected).

The protective stop placement is still wrapped **best-effort** (`tryProtectiveStop` → null on any error), so a venue that rejects it degrades to bot-managed candle-close stops instead of crashing. **Critical ordering:** the position is recorded (`savePosition`/`saveTrade`) *before* the stop is attempted, so a filled entry can never be orphaned if the stop placement fails. Use `npm run flatten` to recover any untracked/orphaned exchange positions.

### Brokers ([src/engine/broker.ts](src/engine/broker.ts))
The engine is broker-agnostic. `LiveBroker` = real Binance orders; `PaperBroker` = in-memory sim (slippage + taker fee, the backtest's cost model). **Venue is chosen by the npm command, not by `MODE`** — `MODE` is read *only* by `backtest`. `run.ts` sets the base URL per command and enforces the mainnet opt-in.

### Strategy: trend-pullback ONLY
`trend-pullback` is the **only** playbook run, and it's intentional. Walk-forward backtests (recorded in the memory note) show `trend-breakout` is net-negative in *both* periods, and the combo is *worse* than pullback alone — with shared `MAX_OPEN_POSITIONS` slots, breakout's bad signals **crowd out** pullback's good trades. `trendBreakout.ts` stays in the tree but **disabled — do not enable it, especially not as a combo.**

Config (2026-06-10 sweep winner — `npm run sweep`, 72 combos × 2 walk-forward splits, LIVE_SIM on the live 45-symbol universe — **refined 2026-06-17**): `ADX_MIN=35 ATR_MULT=1.5 TAKE1=0 TAKE2=0.5 MAX_HOLD_BARS=12 STALL_BARS=12 TRAIL_MULT=4 COOLDOWN=6 MAX_OPEN_POSITIONS=4 MAX_PER_SIDE=3 MAX_NOTIONAL_PCT=0.5 MAX_STOP_WIDTH_PCT=0.05 ENTRY_ALIGN=true`. **The 2026-06-17 refinements (all walk-forward validated at honest 5bps slippage):** `TRAIL_MULT` 3→4 (looser trail lets winners run, +25% net, OOS PF +0.02 both splits, ~+6pt max DD); `MAX_PER_SIDE=3` (cap concurrent same-side positions — anti-correlation); `MAX_STOP_WIDTH_PCT=0.05` (skip entries whose ATR-stop > 5% of price — a −EV vol bucket); and the **EMA200 fetch fix (`fetchSymbolData` 320→1000 candles)** so live EMA200 converges and matches the backtest (`EMA_CONVERGE_BARS`; audit `tsx src/scripts/audit-warmup.ts`). The original sweep tuned the first block; ~20 further exit-side tweaks (60/30/10, early-BE, faster reversal, 2h cap, loss-streak breaker) all HURT — the thin edge lives in the runners. Non-obvious interactions, all data-backed: ATR 1.5 beats 2.0 only WITH the guardian active (the 15m flip-exit absorbs tight-stop whipsaw); the short 12/12 time-stops only work WITH the selective ADX35 gate (with ADX25 they were −EV); `maxOpen` 6/8 flip the edge negative and balloon DD (slots only fill in correlated bursts); the $500 cap binds on tight stops so effective risk is ~0.3–0.5%, not 1%. **Cardinal caveat: the edge is THIN (walk-forward PF 1.02–1.13, ✅both on 2 splits) and only replay-validated — judge every config change with `LIVE_SIM=true BACKTEST_SYMBOLS=env`, never the bare backtest, and keep live size tiny.** The full risk picture lives in [README.md](README.md) §7; the operator-facing Vietnamese guide is [HUONG_DAN_VI.md](HUONG_DAN_VI.md).

### Risk & money safety (M8)
- Sizing: fixed `RISK_PCT` of equity, OR fixed `RISK_USDT` (overrides pct — use ~1 for the first live phase). Hard caps `MAX_TRADE_RISK_USDT` / `MAX_NOTIONAL_PER_TRADE` only shrink size, never grow it ([src/risk/sizing.ts](src/risk/sizing.ts)).
- Mainnet `live` needs **two independent keys** (`ALLOW_LIVE` + `CONFIRM_LIVE`) + a loud banner + 5s countdown + forced one-way mode. testnet/demo endpoints (`testnet`/`demo` in the URL) are treated as risk-free and bypass the opt-in.

### Exchange client ([src/exchange/binance.ts](src/exchange/binance.ts))
Native `fapi` REST (no ccxt). HMAC-SHA256 signing, server-time sync, rate-limit header tracking, retry/backoff. Non-obvious invariants:
- **Timestamp must be an integer** — the synced offset can be fractional, so it's `Math.round`ed; a float timestamp triggers `-1102`.
- **`baseUrl` is a mutable module global** set via `setBaseUrl` (so `live` targets mainnet while `collect`/`backtest` use mainnet public data and `testnet` targets demo). `rawFetch` reads the mutable var, not `config.binance.baseUrl` — do not revert that.
- Errors throw `BinanceApiError` carrying the structured `.code`; check with `isBinanceCode(err, -2011)`, **not** `err.message.includes(...)`.

### Dashboard ([src/dashboard/](src/dashboard/))
Zero-dependency native `http` server + a single self-contained HTML page polling `/api/state` every 5s. Trades/equity/positions come from **SQLite** (so equity is a per-tick snapshot, not live); **live mark prices for open positions are fetched from the venue** (public `premiumIndex`, no keys) so per-position **unrealized PnL is real-time** like the Binance UI. The dashboard points the public client at the right venue via `useVenue(engine:label === "LIVE")`. The venue **badge** comes from `engine:label`, and the engine writes a **startup equity snapshot** so the balance shows immediately. Deliberately not Next.js — keep it dep-light.

## Storage & DB separation
`getDb()` ([src/storage/db.ts](src/storage/db.ts)) runs `CREATE TABLE IF NOT EXISTS` migrations on whatever `DB_PATH` points at. Tables: `candles`, `funding_rates`, `trades`, `live_positions`, `equity_snapshots`, `engine_meta`, `universe_snapshots`.

**Three databases, by role** — the npm scripts set `DB_PATH` so they never mix:
- `data/binance.sqlite` — **research** (candles + funding + backtests). The live engine does *not* need it (it fetches klines from the API in real time).
- `data/testnet.sqlite` — testnet trade journal.
- `data/live.sqlite` — live trade journal.

A trade's `id` encodes its source: `…-live` = real exchange order, `…-paper` = simulation. Use this to tell real fills from dry-run pollution.

## Conventions worth preserving
- ESM with `.js` import suffixes on `.ts` sources. `strict` + `noUncheckedIndexedAccess` on — array access is `T | undefined`.
- `tsx` runs sources directly; `typecheck` is the only gate. Run it after every change.
- Tunables flow through env → [src/config.ts](src/config.ts) → typed `config`. Add new ones there; don't read `process.env` directly (engine strategy knobs go through the shared `paramsFromEnv` in [src/playbooks/paramsFromEnv.ts](src/playbooks/paramsFromEnv.ts), used by **both** the backtest and the live engine so they never drift).
- Round every price to tick / qty to step before sending an order (`roundToTick`/`roundToStep`) or Binance rejects it (`-1111`/`-2010`).
- Logger is the tiny one in [src/logger.ts](src/logger.ts); don't add winston/pino. `LOG_LEVEL=debug` for detail.
- Telegram ([src/notifications/telegram.ts](src/notifications/telegram.ts)) is a no-op unless `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set — never let it throw into the trading path (`void notifyEvent(...)`).
- Funding is real on testnet/live (the exchange charges it); only paper/dry-run models it (`modelFunding`).
- **Discipline: nothing goes live until it clears the backtest gate (+EV after fees, out-of-sample).** This bot's edge is reverse-engineered and marginal — verify with data, keep real size tiny.
