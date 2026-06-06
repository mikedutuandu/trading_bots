# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

| Command | Purpose |
|---|---|
| `npm run collect` | Main long-running process — polls Polymarket, streams BTC, computes fair value, places paper + live trades, writes to `data/ticks.sqlite`. |
| `npm run discover` | One-shot smoke test — finds active `btc-up-or-down-5m` events and prints UP/DOWN order books. Sum of mids should ≈ 1.0. |
| `npm run btc-feed` | One-shot smoke test — confirms Binance WS feed delivers ticks. |
| `npm run chainlink-feed` | One-shot smoke test — confirms Polymarket RTDS Chainlink feed. |
| `npm run backtest` | Replays every tick row through `decide()` + Kelly sizing; prints P&L, win rate, ROI for the current `STRATEGY_*` config. |
| `npm run analyze-live` | Group resolved trades by side / entry price / edge / vol / drift / BTC distance / time-in-window. Combines `paper_trades` + `live_trades`. |
| `npm run live-smoke-test` | Authenticates against Polymarket CLOB v2 and prints USDC balance. Use before going live. |
| `npm run live-test-order` | Places ONE small live order to validate the full execution path. |
| `npm run find-proxy` | Derives the POLY_1271 deposit-wallet address from a private key. |
| `npm run backfill` | Re-fetches Polymarket outcomes for windows that resolved while the bot was offline. |
| `npm run typecheck` | `tsc --noEmit`. There is no test runner, no linter — `typecheck` is the only static check. |
| `npm run build` | `tsc` → `./dist`. Not used at runtime; `tsx` runs sources directly. |

Runtime: Node ≥20, ESM (`"type": "module"`), TypeScript executed via `tsx`. Imports use `.js` extensions even though sources are `.ts` (ESM + Bundler resolution). Preserve this when adding files.

## Architecture

The pipeline is a single in-process loop in [src/main.ts](src/main.ts). Read [DOCS.md](DOCS.md) for the math; the structural points worth knowing up-front:

**Three timers drive everything:**
- `refreshEvents` every 60s — re-pulls upcoming 5m events from Gamma.
- `pollTick` every `TICK_INTERVAL_MS` (default 5s) — fetches order books, computes fair value, possibly places paper + live trades, writes a `ticks` row.
- Stuck-detection check every 60s — if `pollTick` hasn't run in 5 min, fires a Telegram alert.

Window rollover (`rolloverIfNeeded`) is driven by the tick loop — when the current event slug changes, it settles open paper positions for the previous window and snapshots the new window's open BTC price.

**Data flow (one tick):**
```
BTC feed (Binance WS or Chainlink RTDS) ──► RollingRealizedVol ──► σ
                                                                   ▼
Gamma /events ──► pickCurrentBtc5m ──► event (slug, yes/no tokenIds, window times)
                                                                   ▼
CLOB /book ──► bestQuotes ──► UP/DOWN bid/ask/mid
                                                                   ▼
fairValue(spot, strike, T, σ, drift=0) ──► P(Up)_bs
                                                                   ▼
blendWithMarket(P(Up)_bs, market_mid, marketWeight) ──► P(Up)_blended
                                                                   ▼
decide(...) ──► side + takerPrice + edge  (filters: minEdge / maxEdge / minFvUp / minEntryPrice / maxEntryPrice / maxSpread / time band / maxVol / maxBtcMovedPct)
                                                                   ▼
kellyRiskUsd(...) ──► riskUsd_kelly  (quarter-Kelly default, capped by RISK_MAX_PER_TRADE_USD)
                                                                   ▼
risk caps + Polymarket min-shares bump ──► actualRiskUsd / shares
                                                                   ▼
[if PAPER_ENABLED] paper.open(...)                              ──► tracked in-memory + recorded on window resolve
[if LIVE_TRADING + live OK] placeLiveOrder(...) via LiveTrader  ──► CLOB v2 order, then store.recordLiveOrderPlaced
```

**Strategy filter pipeline ([src/strategy/signal.ts](src/strategy/signal.ts)):**
Filters are applied in order; the first rejection wins. Key non-obvious ones:
- `minFvUp` is **symmetric**: UP requires `fair.pUp ≥ minFvUp`, DOWN requires `fair.pUp ≤ 1 - minFvUp`. Setting it to 0.50 eliminates the "dead zone" entirely.
- `blockAgainstTrend` (always on unless explicitly disabled) rejects UP when BTC is below strike, DOWN when above, AND rejects any side if BTC moved more than `maxBtcMovedPct` from window open (default 0.3%).
- `maxEdge` exists because live data showed bot loses when it disagrees with the market by too much — the market is usually right at extreme disagreement.

**Live trading is wired in** (was previously a stub):
- `LiveTrader` (in [src/execution/live.ts](src/execution/live.ts)) handles CLOB v2 auth via POLY_1271 (deposit-wallet model post-April-2026).
- Triple safety: `LIVE_TRADING=false` (master), `LIVE_DRY_RUN=true` (logs only), `LIVE_MAX_TRADE_USD` (hard cap).
- Live and paper sizing are identical so paper P&L predicts live P&L.
- Dedup: `liveOrdersInFlight` Set (in-memory, with 30s timeout cleanup) + `hasPlacedLiveOrderForSlug` (DB-backed, counts both `PENDING` and `PLACED`).
- **Reserve-then-place (restart-safe):** `placeLiveOrder` writes a `PENDING` live_trades row *synchronously before* the `placeBuy` network call, then flips it to `PLACED`/`FAILED` once the API responds. Because the slug dedup counts `PENDING`, a crash mid-`placeBuy` can never produce a duplicate real-money order on restart. `reconcilePendingLiveTrades` (startup + reconcile interval) resolves orphaned `PENDING` rows: adopt a matching resting order (`getOpenOrders`) or fill (`getTrades`), else mark `FAILED` — but only *after* the window has closed, so an unconfirmed order keeps blocking duplicates while its window is live. Keep the PENDING-row write before any `await`; do not reorder.

**PAPER_ENABLED toggle:**
- When `true` (default): paper trades run alongside live for analytics. Risk manager state lives in the paper layer.
- When `false`: skip paper entirely. Live dedup falls back to DB-backed `hasPlacedLiveOrderForSlug`. Risk manager becomes dormant. Use this if paper's in-memory state ever gets stuck.

**Price source switch:** `BTC_PRICE_SOURCE=chainlink` (default, matches Polymarket settlement source) or `binance` (faster ticks, slight lead time over Chainlink). Switching changes the live signal but not how Polymarket resolves.

**Strike convention:** the "strike" for the fair-value model is `windowOpenBtcPrice` — the price (from the active feed) captured the moment a new event becomes current, not the Chainlink open at window start. This is a known approximation (see DOCS §10.1). **Restart-safe:** on rollover, `windowOpenBtcPrice` is recovered from the earliest recorded tick's `btc_price_at_window_start` for the slug (`store.recoverWindowOpenPrice`), falling back to live spot only when there are no prior ticks (a genuinely fresh window). This stops a mid-window restart from resetting the strike to the restart-moment spot — which would zero out `priceTrend` and silently bypass the `maxBtcMovedPct` / `blockAgainstTrend` guards, producing spurious trades. The `New window` log line reports `openSource: "recovered-from-db" | "live-spot"`.

**Bot only buys.** Both sides are BUY orders against the appropriate (UP or DOWN) token. No sell logic; positions resolve at window close. Don't add exit/cancel logic unless asked.

**Bayesian blend ([src/analysis/fairvalue.ts](src/analysis/fairvalue.ts)):** raw Black-Scholes `pUp` gets blended with the Polymarket UP mid as a prior (`STRATEGY_MARKET_WEIGHT`). When weight=0 the bot uses pure BS (overconfident, historically lost when strongly disagreeing with market). Live `fair_value_up` in the DB is the **blended** value; recover raw BS via `(blended − w × up_mid) / (1 − w)`.

**Drift hardcoded to 0** in the live pollTick call — the 30-min rolling drift estimate is too noisy at this sample size. The computed drift is still recorded in `drift_at_entry` for analysis.

**Config:** all tunables flow through env → [src/config.ts](src/config.ts) → typed `config` object. Add new tunables there rather than reading `process.env` directly.

**Storage** ([src/storage/db.ts](src/storage/db.ts)): five conceptual stores
- `ticks` — every poll (orderbook + fv + edges + spot).
- `window_outcomes` — per-window resolution (local guess + authoritative Polymarket outcome).
- `paper_trades` — resolved paper positions with full context (entry BTC, vol, drift, both sides' bid/ask, etc.).
- `live_trades` — placed orders with status (PLACED/FILLED/PARTIAL/CANCELLED/FAILED), fill price, fees, and resolution.
- Each trade row also stores: `strategy_config` (JSON snapshot of all STRATEGY params at trade time, for per-config analytics), `btc_price_source`, `kelly_recommended_risk_usd` (pre-cap), and VIRTUAL generated `*_at_iso` columns for human-readable timestamps.

SQLite is append-only by convention; restarting `collect` is safe. Schema migrations live at the top of the `TickStore` constructor via `PRAGMA table_info`/`table_xinfo` checks + `ALTER TABLE ADD COLUMN`.

**Telegram notifications** ([src/notifications/telegram.ts](src/notifications/telegram.ts)) cover:
- Trade placed / rejected
- Hourly stats summary (balance + win rate + P&L; paper section conditionally included)
- Bot crashed (uncaughtException, unhandledRejection)
- Bot stuck (>5 min without a `pollTick` firing)

## Conventions worth preserving

- ESM with `.js` import suffixes on `.ts` sources.
- `strict` + `noUncheckedIndexedAccess` are on — array access returns `T | undefined`.
- Logger is the tiny one in [src/logger.ts](src/logger.ts); don't pull in winston/pino. Set `LOG_LEVEL=debug` to see signal rejections.
- Network calls have minimal retry/backoff; failures are logged at `debug`/`warn` and the loop continues. Don't add aggressive retry — the next tick recovers naturally.
- When adding a new strategy filter, expose it via env → `config.strategy.*` → `SignalInputs` field → check in `decide()`. Keep the rejection message specific (e.g. `edge 0.07 < 0.08`) so debug logs are useful.
- When adding a tracked field to trades, update **both** `paper_trades` and `live_trades` (schema, insert SQL, types, and the call sites in `main.ts`).
