# Binance Futures Bot — Complete Build Plan (A→Z)

> Full roadmap to build the bot, from scaffold to live. Each milestone has a
> **goal**, the **files to write**, and a **DONE gate** — do not advance to the
> next milestone until the current gate passes.
> Stack: TypeScript (ESM) · tsx · better-sqlite3 · zod · native Binance API (no ccxt).
>
> Reverse-engineered from the reference bot: 1h timeframe, ~60 coins,
> **risk 1%/trade**, **leverage ~10x**, R-based sizing, TP1/2/3 + breakeven,
> multi-position (max ~3).

---

## 0. Principles (apply throughout)
1. **Backtest must be net-positive after fees** before any real money goes in.
2. **Fixed risk 1% equity/trade** — notional is derived from the stop, never fixed.
3. **Every parameter is config** (EMA, ATR, risk%, leverage…) — tunable, not hardcoded.
4. **Build the engine once, reuse it** for backtest / paper / live (same logic path).
5. **Testnet first, real money later**, and start at the smallest possible size.

---

## Dependency map (required order)
```
M0 Scaffold ─► M1 Exchange(read) ─► M2 Storage ─► M3 Indicators ─► M4 Strategy
                                                                      │
                          M5 Risk/Sizing ◄────────────────────────────┘
                               │
                               ▼
        M6 Backtest ─►(GATE: +EV after fees, OOS)─► M7 Live testnet ─► M8 Live real (tiny)
                                                            │
                                                            ▼
                                                  M9 Dashboard + Ops
```

---

## M0 — Project scaffold
**Goal:** runnable skeleton, typecheck passes, config validates.

**Files:**
- `package.json` — scripts: `collect`, `backtest`, `paper`, `live`, `typecheck`
- `tsconfig.json` — copy from poli_bot
- `.env.example` / `.env` — API keys, base URLs, flags
- `src/config.ts` — read env + **zod validate**, export config object
- `src/logger.ts` — structured logging (copy poli_bot)
- `src/types.ts` — core types: `Candle`, `Symbol`, `Side`, `Signal`, `Trade`, `Position`, `Playbook`, `CloseReason`
- `.gitignore` — node_modules, .env, data/*.db

**Minimum config (`config.ts`):**
```
BINANCE_API_KEY, BINANCE_API_SECRET
BINANCE_BASE_URL        (mainnet vs testnet.binancefuture.com)
MODE                    (backtest | paper | live)
RISK_PCT = 0.01         (1% equity/trade)
LEVERAGE = 10
MAX_OPEN_POSITIONS = 3
MAX_DAILY_LOSS_PCT = 0.05  (kill switch)
TIMEFRAME = '1h'

# Universe (dynamic top-N by volume, pinned for backtest)
UNIVERSE_MODE   = 'dynamic'      // 'dynamic' | 'static'
UNIVERSE_SIZE   = 50             // top 50 USDT-M perps by 24h volume
MIN_24H_VOLUME  = 50_000_000     // floor; skip illiquid coins
DENYLIST        = ['USDCUSDT','FDUSDUSDT','BTCDOMUSDT', ...stablecoins/wrapped]
SYMBOLS         = []             // used only when UNIVERSE_MODE='static' (or pinned backtest snapshot)
```

**✅ GATE:** `npm run typecheck` passes; `config.ts` throws a clear error on missing env.

---

## M1 — Exchange layer (READ only first)
**Goal:** fetch market data from Binance Futures; no order placement yet.

**Files:**
- `src/exchange/binance.ts` — HTTP client: signed/unsigned requests, HMAC-SHA256, `recvWindow`, server-time sync, read `X-MBX-USED-WEIGHT` header (rate limit), retry/backoff
- `src/exchange/marketData.ts`:
  - `getKlines(symbol, interval, limit/startTime)` → `Candle[]`
  - `getExchangeInfo()` → tickSize, stepSize, minNotional per symbol (cached)
  - `getFundingRate(symbol)`, `getMarkPrice(symbol)`
  - `getUniverse()` → resolves the tradable set: dynamic top-`UNIVERSE_SIZE` by 24h
    volume, filtered by `MIN_24H_VOLUME` and `DENYLIST` (or returns `SYMBOLS` when
    `UNIVERSE_MODE='static'`). Plus a one-time `snapshotUniverse()` to freeze the
    current top-50 into a fixed list for reproducible backtests.

**Native API details to handle ourselves:**
- Base: `https://fapi.binance.com` (mainnet) / `https://testnet.binancefuture.com`
- Klines: `GET /fapi/v1/klines`
- ExchangeInfo: `GET /fapi/v1/exchangeInfo`
- Funding: `GET /fapi/v1/premiumIndex`
- 24h ticker (volume): `GET /fapi/v1/ticker/24hr`

**✅ GATE:** fetch BTCUSDT 1h klines and print to console; parse tick/step size correctly.

---

## M2 — Storage (SQLite)
**Goal:** cache candles + trade journal, for backtesting and auditing.

**Files:**
- `src/storage/db.ts` — open DB, run migrations (CREATE TABLE IF NOT EXISTS)
- `src/storage/candles.ts` — upsert + query candles by (symbol, interval, time)
- `src/storage/trades.ts` — write/read trade journal

**Schema:**
```sql
candles(symbol, interval, open_time, open, high, low, close, volume,
        PRIMARY KEY(symbol, interval, open_time))

trades(id, symbol, side, playbook, setup, timeframe,
       entry_price, stop_price, qty, notional, leverage,
       risk_usdt, r_planned,
       tp1, tp2, tp3,
       status,                -- OPEN | CLOSED
       exit_price, close_reason,  -- TP3|MANAGED_STOP|HEALTH_CLOSE|STOP
       r_realized, gross_pnl, commission, funding, net_pnl,
       opened_at, closed_at)

equity_snapshots(ts, equity, available, margin_used, open_positions)
```

**Script:** `src/scripts/collect.ts` — download 1h history for ~60 coins (use
`data.binance.vision` for long history, or the klines API), store in `candles`.

**✅ GATE:** `npm run collect` downloads ≥ 1 year of 1h candles for 60 coins into
SQLite; re-running creates no duplicates (idempotent).

---

## M3 — Indicators (TA)
**Goal:** the indicators used to detect trend & entries.

**File:** `src/indicators/ta.ts` — pure functions, input `Candle[]` → value arrays:
- `ema(values, period)`
- `atr(candles, period)` — volatility → drives stop & sizing
- `rsi(candles, period)`
- `adx(candles, period)` — chop filter
- `donchian(candles, period)` → {upper, lower} for breakout
- `swingHigh/swingLow(candles, lookback)`

**✅ GATE:** small unit test — compare EMA/ATR against hand-computed values on a
sample array; they match.

---

## M4 — Strategy / Playbooks
**Goal:** generate entry signals. Build **trend-pullback first** (the money-maker).

**Files:**
- `src/playbooks/types.ts`
  ```ts
  interface Playbook {
    name: string;
    detect(candles: Candle[], ctx: MarketCtx): Signal | null;
  }
  // Signal { side, entry, stop, tp1, tp2, tp3, playbook, setup }
  ```
- `src/playbooks/trendPullback.ts` — **build first**
  - Trend: EMA50 vs EMA200 → trade only with the trend
  - (optional) ADX(14) ≥ 20 to filter sideways
  - Pullback: price touches EMA20 / nearest swing
  - Trigger: reversal candle in the trend direction
  - Stop: `entry ∓ k*ATR(14)` (k≈1.5) or beyond the swing
  - TP1=+1R, TP2=+2R, TP3=+3R
- `src/playbooks/trendBreakout.ts` — build later
  - Donchian(20) breakout + "retest" variant
- `src/playbooks/index.ts` — register playbooks, enable/disable via config

**✅ GATE:** run `detect()` over one coin's history, print a sensible list of
signals (correct trend direction, stop on the correct side).

---

## M5 — Risk & Position Management
**Goal:** turn a signal → position size; manage the trade lifecycle.

**Files:**
- `src/risk/sizing.ts`
  ```
  riskUsdt   = equity * RISK_PCT          // 1%
  stopDist   = |entry - stop|
  qtyRaw     = riskUsdt / stopDist
  qty        = roundToStepSize(qtyRaw)    // per exchangeInfo
  notional   = qty * entry
  margin     = notional / LEVERAGE
  // guard: notional ≥ minNotional; skip trade if not met
  ```
- `src/risk/manage.ts` — manage open trades each candle:
  - Hit TP1 → take 1/3 off + **move SL to breakeven**
  - Hit TP2 → take 1/3 off
  - Hit TP3 → close the rest (or ATR trailing)
  - **HEALTH_CLOSE**: trend flips (EMA50 crosses EMA200 against you) or time-stop after N bars
  - **MANAGED_STOP**: trailing stop after breakeven
- `src/risk/portfolio.ts` — portfolio-level rules:
  - `MAX_OPEN_POSITIONS` (3)
  - total open risk ≤ X%
  - correlation guard (avoid many same-direction trades on correlated coins)
  - **kill switch**: stop new entries if daily loss ≥ `MAX_DAILY_LOSS_PCT`

**✅ GATE:** for (equity=370, risk=1%, entry, stop) → qty/notional/margin match
hand calc; respect step/tick/minNotional.

---

## M6 — Backtest Engine ⭐ (the decisive step)
**Goal:** prove the edge on historical data, **net of fees + funding**.

**Files:**
- `src/engine/loop.ts` — shared core loop: `scan → detect → size → execute → manage`
- `src/engine/paperBroker.ts` — simulated fills (fill at price, deduct fees + slippage)
- `src/backtest/runner.ts` — replay candles in time across the universe, call the engine, use paperBroker
- `src/backtest/metrics.ts` — report:
  - Win rate, expectancy (R/trade), profit factor
  - **Max drawdown**, equity curve
  - Net **after commission + funding + slippage**
  - Breakdown by **playbook**, by coin, by month
- `src/scripts/backtest.ts` — CLI: pick date range, playbook, print report

**Avoid traps:** no lookahead (use only closed candles), model realistic fees
(taker ~0.04%/side), slippage, funding every 8h.

**Walk-forward:** tune params on 2022–2023, **test untouched** on 2024–2025.

**✅ GATE (most important):**
- Expectancy **> 0 after fees** on the test set (out-of-sample), not just in-sample.
- Acceptable max drawdown (e.g. < 20%).
- Stable across many coins/months, not carried by 1–2 lucky trades.
- ❌ **Fails → go back to M4/M5 and tune, DO NOT advance to M7.**

---

## M7 — Live on Binance Testnet (forward-test)
**Goal:** place real orders via API on testnet (no money at risk). This also serves
as the forward-test: run the engine on live data and confirm live trades ≈ backtest.

**Files:**
- `src/scripts/paper.ts` — run the engine real-time: cron scan hourly (on 1h candle
  close); also log what the backtest `paperBroker` would have filled, side by side
- `src/exchange/account.ts` — balance, positions, set leverage, set margin type
- `src/exchange/orders.ts` — `placeOrder`, `placeStop`, `cancel`, read fills; round to tick/step
- `src/exchange/userStream.ts` — WS user-data stream (listenKey + keepalive) for real-time fills
- `src/engine/liveBroker.ts` — same broker interface but calls real Binance
- `src/scripts/live.ts` — run the engine with liveBroker; **read `MODE` + testnet flag**
- (optional) `src/notifications/telegram.ts` — alert on open/close, errors

**Required guardrails:**
- Default to testnet; enabling mainnet requires a separate flag + confirmation.
- Idempotent orders (clientOrderId) to avoid duplicate placement on retry.
- Reconcile: on startup, sync real positions from the exchange (don't blindly trust the DB).

**Duration:** run 1–2 weeks.

**✅ GATE:** full trade lifecycle on testnet (entry → SL → TP) with DB and exchange in
agreement; live trades **reasonably match the backtest**; kill switch works.

---

## M8 — Live with real money (smallest size)
**Goal:** validate the real edge with minimal risk.

- Set `RISK_PCT` very small at first (e.g. risk ~1 USDT/trade) or a small account (e.g. 50–100 USDT).
- API key: enable Futures, **disable withdrawals**, **IP-whitelist**.
- Monitor for ≥ several weeks, compare to backtest.
- **Scale size up only gradually** once real numbers are stable.

**✅ GATE:** real PnL after fees is positive & matches expectations over a large
enough sample (≥ a few dozen trades) → only then scale.

---

## M9 — Dashboard + Operations
**Goal:** observe & operate like the reference bot.

- Dashboard (Next.js, like your friend's UI): equity, realized/unrealized PnL, win
  rate, open/closed trades, fees/funding, playbook performance, filters.
- Read from SQLite (or a small API).
- Alerts (Telegram): new trade, errors, kill switch triggered.
- Health checks: worker online, exchange connected, scan timestamp, issues count.
- Periodic DB backup.

**✅ GATE:** see bot state in real time; receive alerts on incidents.

---

## Milestone summary

| M | Name | Output | Gate to pass |
|---|---|---|---|
| M0 | Scaffold | skeleton + config | typecheck passes |
| M1 | Exchange read | klines, exchangeInfo | fetch BTC candles |
| M2 | Storage | SQLite + collect | 1y data, 60 coins |
| M3 | Indicators | EMA/ATR/ADX/Donchian | match hand calc |
| M4 | Strategy | trend-pullback | sensible signals |
| M5 | Risk/Sizing | sizing + manage | qty/margin correct |
| **M6** | **Backtest** | runner + metrics | **+EV after fees (OOS)** ⭐ |
| M7 | Live testnet | orders + WS, forward-test | lifecycle OK + matches backtest |
| M8 | Live real tiny | real money | +EV real → scale |
| M9 | Dashboard/Ops | UI + alerts | observable |

---

## Estimate & advice
- **M0–M5** (foundation + strategy): the bulk of the coding, done sequentially.
- **M6 is the single most important gate** — don't rush it. Most bots lose because
  they skip this step.
- **M7–M8**: mostly waiting time (running live to observe), little new code.
- Remember: your friend's bot **proves the approach is viable**, but our version
  must **prove itself via backtest**, because we reverse-engineered the parameters.

## Decisions
1. ✅ **Universe:** dynamic top-50 by 24h volume + `MIN_24H_VOLUME` floor + denylist;
   pinned to a snapshot for backtests. (`UNIVERSE_MODE='dynamic'`, `UNIVERSE_SIZE=50`)
2. ✅ **Historical data source:** `data.binance.vision` (long history, free).
3. ✅ **Default `RISK_PCT`:** `0.01` (1%, like the reference) in config — lower to
   0.5% for the first real-money phase (M9).
