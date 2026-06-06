# Polymarket BTC 5m Up/Down Trading Bot — Complete Documentation

## 1. What this bot does

It trades the **`btc-up-or-down-5m` series** on [Polymarket](https://polymarket.com) — binary 5-minute prediction markets that resolve **Up** if BTC's Chainlink BTC/USD price at the end of the window is ≥ the price at the start, otherwise **Down**.

The bot:
1. Discovers the currently-open 5m market and its order book.
2. Streams BTC spot price from Binance (free, low-latency proxy for Chainlink).
3. Computes a **fair-value probability** P(Up) from BTC realized volatility, using a lognormal/Black-Scholes-style model.
4. Compares fair value to Polymarket's implied probability (the order book best ask).
5. When the gap exceeds a threshold, it sizes a position via **fractional Kelly** and either paper-trades it or places a real limit order via the official `@polymarket/clob-client-v2`.
6. Resolves positions when the window closes and logs P&L.

The architecture is intentionally phased so you can build confidence at each stage before risking money.

---

## 2. Architecture at a glance

```
                     ┌───────────────────────┐
                     │  Binance WS feed      │  (BTC/USDT trade + bookTicker)
                     │  src/btc/binance-ws.ts│
                     └──────────┬────────────┘
                                │  price stream
                                ▼
        ┌─────────────────────────────────────────────────┐
        │  RollingRealizedVol   (1m closes → annualized σ)│
        │  src/btc/volatility.ts                          │
        └──────────────────────┬──────────────────────────┘
                               │  σ
                               ▼
┌──────────────────────┐   ┌────────────────────────────────┐
│  Polymarket Gamma    │   │  fairValue() — Black-Scholes-style │
│  src/polymarket/     │──►│  P(Up | spot, strike, σ, T)        │
│  gamma.ts            │   │  src/analysis/fairvalue.ts         │
│  (event discovery)   │   └─────────────┬──────────────────────┘
└──────────────────────┘                 │
                                         ▼
┌──────────────────────┐   ┌────────────────────────────────┐
│  Polymarket CLOB     │   │  decide() — edge vs market     │
│  /book endpoint      │──►│  src/strategy/signal.ts        │
│  src/polymarket/     │   └─────────────┬──────────────────┘
│  clob.ts             │                 │  side, taker price
└──────────────────────┘                 ▼
                                  ┌────────────────────────┐
                                  │  Kelly sizing          │
                                  │  src/strategy/sizing.ts│
                                  └────────────┬───────────┘
                                               │  riskUsd
                                               ▼
                              ┌────────────────────────────┐
                              │  RiskManager (limits)      │
                              │  src/execution/risk.ts     │
                              └────────────┬───────────────┘
                                           │
                            ┌──────────────┴─────────────┐
                            ▼                            ▼
            ┌────────────────────────┐    ┌──────────────────────────┐
            │  PaperTrader           │    │  LiveTrader              │
            │  src/execution/paper.ts│    │  src/execution/live.ts   │
            │  (simulated fills)     │    │  (clob-client-v2 + viem) │
            └────────────┬───────────┘    └──────────────────────────┘
                         │  trades, P&L
                         ▼
                 ┌────────────────────┐
                 │  TickStore (SQLite)│
                 │  src/storage/db.ts │
                 └────────────────────┘
```

Everything is glued together by `src/main.ts`, which runs two timers:
- **Event-refresh loop** (every 60s) — re-pulls the list of upcoming markets.
- **Tick loop** (every 5s by default) — fetches both order books, computes fair value, evaluates the strategy, opens paper positions, writes a row to SQLite.

---

## 3. The Polymarket market structure

### 3.1 Series

Polymarket organizes recurring markets into **series**. The one we target:

| Property | Value |
|---|---|
| Series slug | `btc-up-or-down-5m` |
| Series id | `10684` |
| Recurrence | every 5 minutes |
| Restricted | `true` (hidden from default `/series` listing) |
| 24h volume | ~$24M |
| Outcomes | `["Up", "Down"]` |
| Tick size | 0.01 |
| Min order size | 5 shares |
| Resolution source | [Chainlink BTC/USD data stream](https://data.chain.link/streams/btc-usd) |

### 3.2 Event slugs

Each 5-minute window is a separate event with slug `btc-updown-5m-{endTsSeconds}`, where the timestamp is the **end** of the window (Unix seconds, divisible by 300).

Example: `btc-updown-5m-1779978600` resolves at `2026-05-28 14:35:00 UTC` (10:35 ET). The window is `14:30:00 → 14:35:00`.

### 3.3 Discovery

The Gamma API doesn't list these via `/series` (they're `restricted: true`). The working query is:

```
GET https://gamma-api.polymarket.com/events
    ?series_id=10684
    &closed=false
    &end_date_min=<ISO-now>
    &limit=20
```

This is implemented in `src/polymarket/gamma.ts → findActiveBtc5mEvents()`.

Two important client-side filters we apply:
- Events stay `active=true closed=false` until they settle, so we drop any whose `endDate <= now`.
- Multiple windows can be "tradable" at once; `pickCurrentBtc5m()` returns the one whose window is currently open (`start <= now < end`).

### 3.4 Reading the order book

Public, no auth required:

```
GET https://clob.polymarket.com/book?token_id=<tokenId>
```

`bids` and `asks` are arrays of `{price, size}`. `bestQuotes()` in `src/polymarket/clob.ts` returns `{bestBid, bestAsk, mid, spread}`.

**Sanity check:** for a binary market, `mid(Up) + mid(Down) ≈ 1`. The bot logs this on startup; large deviations indicate stale data or unusual market conditions.

---

## 4. The strategy

### 4.1 The edge thesis

In an efficient market for a 5-minute BTC price direction, the fair probability is given by the **lognormal distribution** of BTC returns. If the market price differs meaningfully from this fair value, we trade the gap.

A few reasons the gap can exist:
- **Slow reaction**: Polymarket orders are placed by humans and bots; both can lag the spot price.
- **Asymmetric flow**: retail tends to chase momentum; a fast BTC up-move can leave the Up side overpriced.
- **Liquidity gaps**: low-volume windows have wide spreads that occasionally invert briefly.
- **Source basis**: Polymarket resolves on Chainlink; Binance moves first. Small but real edge near window close.

### 4.2 The fair-value model

We assume BTC follows a geometric Brownian motion over the short window:

```
ln(S_T / S_0) ~ Normal( (μ − σ²/2) · T,  σ² · T )
```

Under risk-neutral assumption (μ = 0 for these tiny windows), the probability the close is above the strike (the open price) is:

```
P(S_T > K)  =  N(d₂)

with  d₂ = ( ln(S_now / K)  −  0.5 · σ² · T )  /  ( σ · √T )
```

Where:
- `S_now` = current BTC spot price (Binance)
- `K`     = BTC spot at the moment the window opened
- `T`     = remaining time in years (seconds-remaining / 31,536,000)
- `σ`     = annualized realized volatility from the last 30 minutes of 1m closes
- `N(·)`  = standard normal CDF (implemented via Abramowitz–Stegun 7.1.26)

This lives in `src/analysis/fairvalue.ts → fairValue()`. The normal CDF helper is `src/analysis/normal.ts`.

### 4.3 Picking a side

`src/strategy/signal.ts → decide()` works like this:

```
edgeUp   = fair.pUp   − upOrderbook.bestAsk
edgeDown = fair.pDown − downOrderbook.bestAsk
```

It picks whichever side has the larger positive edge, subject to:

| Filter | Default | Why |
|---|---|---|
| `minEdge` | 0.05 | Need ≥5 percentage points of edge to overcome fees + execution risk |
| `maxSpread` | 0.03 | Wide spread = stale book or thin liquidity, skip |
| `minRemainingSec` | 30 | Not enough time for fills + price to converge |
| `maxRemainingSec` | 270 | Vol estimate is too uncertain this early; price hasn't moved enough yet |

If no candidate clears all filters, no trade.

### 4.4 Position sizing — fractional Kelly

`src/strategy/sizing.ts → kellyRiskUsd()` uses the **binary Kelly formula** for a share bought at price `c` that pays 1 on win:

```
f* = (p − c) / (1 − c)
```

where `p = takerPrice + edge` is the model's win probability. We multiply by `kellyFraction` (default 0.25, i.e. **quarter-Kelly**) for robustness against estimation error, then cap by `maxRiskFraction` of bankroll. The function returns USD at risk; shares = riskUsd / takerPrice.

Quarter-Kelly is the standard choice when you're not 100% confident your edge estimate is calibrated. Full Kelly maximizes geometric growth in theory but in practice burns down accounts that have systematic edge-estimation errors.

### 4.5 The bot only buys

Polymarket binary markets are symmetric: to bet on Up, you buy the Up token; to bet on Down, you buy the Down token. The bot never sells — it holds to resolution. This eliminates a class of bugs (timing exits, cancel-replace logic) at the cost of giving up on early-exit alpha.

---

## 5. Risk management

Defined in `src/execution/risk.ts → RiskManager`. Per-instance limits:

| Limit | Default | Purpose |
|---|---|---|
| `maxOpenPositions` | 3 | Avoid correlated overhang when momentum carries through multiple windows |
| `maxRiskPerTradeUsd` | 5 | Hard cap; Kelly can never exceed this. Start small while building confidence. |
| `maxDailyLossUsd` | 100 | Absolute daily P&L floor; halts new trades |
| `maxWindowsPerDay` | 200 | Caps run-away activity if the signal is bad |
| `stopTradingAtDailyLossPct` | 0.10 | Halt at -10% bankroll drawdown (overrides the absolute limit if smaller) |

State (`openPositions`, `dailyRealizedPnlUsd`, `windowsTradedToday`) resets at UTC midnight. Every order request is gated through `risk.canOpen(riskUsd)`.

---

## 6. The phased build

### Phase 1 — Data collection (no money)

Just runs the pipeline with paper trading disabled-by-default thresholds, logging ticks to SQLite. Goal: see how the fair-value-vs-market edge actually distributes across thousands of windows before you trust the model.

Each tick row captures:
- Polymarket Up/Down best bid, best ask, mid
- Current BTC spot, BTC spot at window-open
- Realized 1m vol
- Computed fair value P(Up)
- Edge on each side

After a day of data, you can query the SQLite directly to see:
- Distribution of edges (are they mostly noise?)
- Win rate of "fake" trades you'd have taken (does positive edge actually predict wins?)
- Time-of-day, vol-regime, or spread effects

### Phase 2 — Fair-value model

Already built (`src/analysis/fairvalue.ts`). The interesting tuning here is **what σ to feed it**. Defaults: 30-minute window of 1m closes. Alternatives worth trying:
- Shorter window (5-10 min) → more reactive but noisier
- EWMA instead of equal-weight
- Implied vol from BTC options (Deribit) → forward-looking

### Phase 3 — Paper trading

`src/execution/paper.ts`. Simulates fills at `bestAsk` (taker), deducts a 2% Polymarket-style taker fee, settles deterministically when the window closes. Writes every trade to the `paper_trades` table for later analysis.

The backtest script (`src/scripts/backtest.ts`) is the offline cousin: it replays the tick history from SQLite and re-runs the strategy as if seeing each tick live.

### Phase 4 — Live execution

`src/execution/live.ts` wraps `@polymarket/clob-client-v2`:

```ts
const trader = new LiveTrader();
await trader.init();
trader.setDryRun(false); // explicit opt-in
await trader.placeBuy({ tokenId, side: "UP", price: 0.55, size: 50 });
```

`init()` is a no-op if `POLYMARKET_PRIVATE_KEY` isn't set, and the trader stays in `DRY_RUN` (logs the would-be order, returns success) until `setDryRun(false)` is called explicitly. **Currently `main.ts` only uses `PaperTrader`** — you have to wire `LiveTrader` in deliberately, which is intentional.

---

## 7. How to run

### 7.1 First-time setup

```bash
cp .env.example .env
npm install
mkdir -p data
```

You don't need a Polymarket account or any money to run Phase 1.

### 7.2 Phase 1 — collect data

```bash
npm run discover    # one-off: confirm market structure and current orderbook
npm run btc-feed    # one-off: confirm Binance WS works
npm run collect     # the data collector — keep running
```

`npm run collect` is the main process. Let it run for a few hours minimum (24h+ recommended) before drawing conclusions. It writes to `data/ticks.sqlite`.

Stop with `Ctrl+C`. Restarting is safe — it appends.

### 7.3 Analyze what you have

```bash
npm run backtest    # replays every logged tick through the strategy
```

Output gives `trades / wins / win-rate / total-pnl / ROI` on simulated trades.

For ad-hoc exploration, just query SQLite directly:

```bash
sqlite3 data/ticks.sqlite
> SELECT COUNT(*) FROM ticks;
> SELECT AVG(edge_up), AVG(edge_down), COUNT(*) FROM ticks WHERE realized_vol_1m IS NOT NULL;
> SELECT side, COUNT(*), AVG(realized_pnl_usd), SUM(realized_pnl_usd) FROM paper_trades GROUP BY side;
```

### 7.4 Phase 4 — going live (when ready)

1. Fund a Polymarket account with USDC on Polygon.
2. Get your wallet private key. Set it in `.env`:
   ```
   POLYMARKET_PRIVATE_KEY=0x...
   POLYMARKET_FUNDER_ADDRESS=0x...   # your deposit-wallet/funder address per CLOB v2
   ```
3. Edit `src/main.ts` to instantiate `LiveTrader`, call `init()`, and route `decide()` outputs into `trader.placeBuy({...})` instead of `paper.open({...})`.
4. **Start with tiny size** (e.g. `bankrollUsd: 50`, `maxRiskPerTradeUsd: 2`). Confirm orders place and settle correctly for a few windows before scaling up.
5. Only call `trader.setDryRun(false)` when you've done that ↑.

---

## 8. Configuration reference

### Environment variables (`.env`)

| Var | Default | Notes |
|---|---|---|
| `POLYMARKET_GAMMA_URL` | `https://gamma-api.polymarket.com` | Public endpoint |
| `POLYMARKET_CLOB_URL` | `https://clob.polymarket.com` | Public endpoint for `/book` |
| `POLYMARKET_PRIVATE_KEY` | _(empty)_ | Phase 4 only |
| `POLYMARKET_FUNDER_ADDRESS` | _(empty)_ | Phase 4 only — CLOB v2 deposit wallet |
| `BINANCE_WS_URL` | `wss://stream.binance.com:9443/ws` | Public BTC/USDT WS |
| `DB_PATH` | `./data/ticks.sqlite` | SQLite file location |
| `TICK_INTERVAL_MS` | `5000` | How often to poll Polymarket order book |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

### Strategy parameters (env vars)

All configurable from `.env`. See `.env.example` for inline explanations.

| Env var | Default | What it controls — in plain English |
|---|---|---|
| `STRATEGY_BANKROLL_USD` | 1000 | Total USD the strategy is allowed to deploy. Scales every position size. Not a deposit — just the math. |
| `STRATEGY_KELLY_FRACTION` | 0.25 | How aggressive position sizing is. `1.0` = full Kelly (mathematically optimal but ruinous if your edge estimate is off). `0.25` (quarter-Kelly) = forgiving. Practical range: 0.1–0.5. |
| `STRATEGY_MIN_EDGE` | 0.05 | Skip trades unless `fair_value − price ≥ this`. **Example:** bot thinks Up is 62% likely and Up is on offer at 0.55 → edge = 0.07 → take it. At 0.04 it would skip. Higher = fewer trades, higher conviction each. |
| `STRATEGY_MAX_SPREAD` | 0.03 | Skip when `bestAsk − bestBid` on the side being traded is wider than this. Wide spread = stale or thin book. Lower = stricter (fewer but cleaner). |
| `STRATEGY_MIN_REMAINING_SEC` | 30 | Don't open new trades in the last `N` seconds of a window — not enough time for the price to come to fair value. |
| `STRATEGY_MAX_REMAINING_SEC` | 270 | Don't open new trades in the first `300 − N` seconds either — early-window vol estimate is noisy and the market hasn't moved much yet. |

### Risk parameters (env vars)

These are **hard stops** — they override the strategy.

| Env var | Default | Purpose |
|---|---|---|
| `RISK_MAX_OPEN_POSITIONS` | 3 | Cap on simultaneous open positions across windows. |
| `RISK_MAX_PER_TRADE_USD` | 5 | Hard ceiling on dollars at risk per single trade — Kelly can never exceed this. Start small while building confidence; raise once the backtest shows real edge. |
| `RISK_MAX_DAILY_LOSS_USD` | 100 | Stop opening new trades for the day once realized losses hit this in USD. |
| `RISK_MAX_WINDOWS_PER_DAY` | 200 | Hard ceiling on # of windows traded per UTC day (catches runaway bugs). |
| `RISK_STOP_AT_DAILY_LOSS_PCT` | 0.10 | Stop for the day once drawdown reaches this fraction of bankroll. Whichever hits first — this or the absolute USD limit. |

---

## 9. Database schema

`data/ticks.sqlite` has three tables. All timestamps are Unix milliseconds unless suffixed `_ts` (seconds).

### `ticks` — one row per polling cycle

| Column | Type | |
|---|---|---|
| `ts` | int | sample time (ms) |
| `window_start_ms` | int | event start time |
| `window_end_ms` | int | event resolution time |
| `market_slug` | text | e.g. `btc-updown-5m-1779978600` |
| `up_best_bid`, `up_best_ask`, `up_mid` | real | Polymarket Up side |
| `down_best_bid`, `down_best_ask`, `down_mid` | real | Polymarket Down side |
| `btc_price` | real | current BTC spot |
| `btc_price_at_window_start` | real | the "strike" |
| `realized_vol_1m` | real | annualized σ from 1-min closes |
| `fair_value_up` | real | model P(Up) |
| `edge_up`, `edge_down` | real | fair − bestAsk per side |

### `window_outcomes` — one row per resolved window

| Column | Type | |
|---|---|---|
| `window_end_ts` | int | primary key (Unix seconds) |
| `market_slug` | text | |
| `btc_price_open`, `btc_price_close` | real | |
| `outcome_up` | int | 1 = Up, 0 = Down |

### `paper_trades` — one row per simulated trade

| Column | Type | |
|---|---|---|
| `window_end_ts` | int | join key to outcomes |
| `market_slug` | text | |
| `side` | text | `"UP"` or `"DOWN"` |
| `entered_at_ms` | int | |
| `taker_price` | real | entry price |
| `shares`, `risk_usd`, `fees_usd` | real | |
| `fair_value_up`, `edge` | real | what the model saw at entry |
| `close_price`, `realized_pnl_usd`, `win` | real/int | filled at settlement |

---

## 10. Known limitations & caveats

### 10.1 Binance is a proxy, not the truth
Polymarket resolves on **Chainlink BTC/USD**. Binance tracks Chainlink very closely but there's a real basis (typically a few dollars). Near the very end of a window (last 5-10 seconds), the difference can be larger than the edge. Either:
- Skip the last 30 seconds (already the default via `minRemainingSec`)
- Pipe in Chainlink for a precise comparison (future work)

### 10.2 The vol estimate is naive
30-min equal-weight rolling stdev is a crude estimator. It lags regime changes and over-weights single outliers. Backtest with EWMA, with shorter windows, and with Deribit implied vol before committing real money.

### 10.3 Latency
Polling at 5s is fine for collecting data but slow for execution. Polymarket also offers a [WebSocket order book stream](https://docs.polymarket.com) — wire this in for Phase 4 to react to book changes within ~100ms.

### 10.4 No order management
The bot places limit orders at the best ask (effectively taker), which leaks edge to fees. A more sophisticated version would:
- Quote at `bestBid + tickSize` and wait for a maker fill
- Cancel and re-quote on book moves
- Track partial fills

### 10.5 No backtest of variance
The backtest reports total P&L but not Sharpe, max drawdown, or hit rate by edge bucket. Easy to add — see future work.

### 10.6 Kelly assumes calibrated probabilities
If your model says 60% but the real win rate at that signal is 52%, full Kelly is a recipe for ruin. Quarter-Kelly is forgiving but not safe — always inspect the **realized win-rate vs predicted probability** before scaling up.

---

## 11. Future improvements

In rough priority order:

1. **Analysis script** — print edge distribution histogram, calibration curve (predicted vs realized P(Up) bucketed), per-hour P&L. Quickest way to learn whether the model has real edge.
2. **WebSocket order book stream** — drop polling latency from 5s to ~100ms.
3. **EWMA realized vol** + **alternative σ sources** — compare against constant-σ baseline.
4. **Maker quoting** — post at `bestBid+tick` instead of crossing the spread.
5. **Chainlink price feed integration** — match Polymarket's resolution source exactly.
6. **Multi-asset** — `eth-up-or-down-5m` is series id `10683`, same shape. Drop-in.
7. **Live execution wiring** — currently `main.ts` only does paper trading. Phase 4 needs a small refactor to route `decide()` results through `LiveTrader` and persist real fills to a new `live_trades` table.
8. **Walk-forward backtesting** — train σ params on the first half, test on the second.
9. **Position-correlation handling** — `maxOpenPositions: 3` is crude; tracking correlation between adjacent windows would be cleaner.
10. **Risk telemetry** — small dashboard (or just a `npm run dashboard` script) showing current open positions, daily P&L, and recent decisions.

---

## 12. File index

| File | Purpose |
|---|---|
| `src/config.ts` | Env var loading |
| `src/logger.ts` | Minimal leveled logger |
| `src/types.ts` | Shared interfaces |
| `src/main.ts` | Entry point — wires everything together |
| `src/polymarket/gamma.ts` | Market discovery via Gamma `/events` |
| `src/polymarket/clob.ts` | Order book fetch + best-quotes helper |
| `src/btc/binance-ws.ts` | Binance WS BTC price feed |
| `src/btc/volatility.ts` | Rolling realized volatility |
| `src/analysis/normal.ts` | Standard normal CDF |
| `src/analysis/fairvalue.ts` | Black-Scholes-style P(Up) |
| `src/strategy/signal.ts` | Edge calc + side selection |
| `src/strategy/sizing.ts` | Fractional Kelly |
| `src/execution/risk.ts` | Pre-trade risk checks + state |
| `src/execution/paper.ts` | Simulated fills + settlement |
| `src/execution/live.ts` | Real order placement (DRY_RUN by default) |
| `src/storage/db.ts` | SQLite logger (ticks, outcomes, paper_trades) |
| `src/scripts/discover-markets.ts` | One-off: show current 5m markets |
| `src/scripts/btc-feed.ts` | One-off: smoke test Binance feed |
| `src/scripts/backtest.ts` | Replay logged ticks through the strategy |

---

## 13. References

- [Polymarket Docs](https://docs.polymarket.com/quickstart)
- [@polymarket/clob-client-v2](https://www.npmjs.com/package/@polymarket/clob-client-v2)
- [Chainlink BTC/USD data stream](https://data.chain.link/streams/btc-usd)
- [Binance WebSocket streams](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)
- Kelly criterion for binary outcomes: Kelly, J.L. (1956), "A New Interpretation of Information Rate."
- Lognormal price model: Hull, *Options, Futures, and Other Derivatives*, Chapter 14.
