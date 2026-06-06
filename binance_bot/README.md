# Binance Futures Trading Bot — Design & Build Plan

> Status: **Planning** · Author: Mike + Claude · Date: 2026-06-04
> Goal: Reproduce (and understand) a profitable systematic long/short Binance
> USDT-M perpetual futures bot, modeled on a friend's production bot.

---

## 1. What the reference bot is (reverse-engineered from its UI)

The friend's dashboard (`prod.monngoncuoituan.com/dashboard`) is a **systematic
multi-symbol Binance USDT-M perpetual futures bot**. Evidence and what each tells us:

| UI signal | What it implies |
|---|---|
| "Margin Usage 4.4%", "Position 16.42 USDT", "Funding +0.31" | Leveraged **perpetual futures**, not spot |
| "Current R", "+2.00R", "−0.86R" | Position sizing & exits are **risk-multiple (R) based** |
| "TP1 / TP2 / TP3", "BE" badges | **Scaled take-profits** + move stop to **breakeven** |
| "HEALTH_CLOSE", "MANAGED_STOP", "TP3" close reasons | Multiple exit paths: trend-invalidation, trailing/managed stop, full TP |
| "trend-pullback", "trend-breakout", "volatility", "intraday" | Several **playbooks** (strategies) run in parallel, each tagged |
| "Scan Jun 04 10:00 PM", "Coins 60", "1h" | Scans ~**60 symbols** on the **1h** timeframe, ~hourly cadence |
| "Win Rate 45.6%" but "+25.43 USDT" net | **Edge is payoff asymmetry**, not hit rate (see below) |

### The core edge (most important thing to copy)

```
Win rate:        45.6%   (loses more often than it wins)
Avg loser:       ~ -0.75R (capped: stop moves to breakeven after TP1)
Avg winner:      ~ +1.9R  (lets trend run to TP3)
Expectancy/trade = 0.456 * (+1.9) - 0.544 * (0.75) ≈ +0.46R  → positive
```

It is **not** a high-accuracy predictor. It's a **trend/pullback follower** that
keeps losers tiny and lets a minority of winners run. The equity curve confirms
it: flat-to-down during the choppy days (05/28–06/01), then sharp gains when
real trends appeared (06/02–06/04). The winning playbook is `trend-pullback`
(+43.22); `volatility`, `intraday`, `trend-breakout` were net negative over this
window — i.e. **one playbook carries the book**.

### Honest caveats before copying it
- **57 closed trades is a tiny sample.** +7% in 7 days is not yet evidence of edge.
- Recent trades are almost all SHORT → it may just be riding one market regime.
- Survivorship/recency bias: we see it *after* a good week. We have no drawdown history.
- **Do not skip backtesting on the assumption "it makes money."**

---

## 2. Recommended architecture

Mirror the existing `poli_bot` conventions: **TypeScript (ESM), `tsx`, `better-sqlite3`,
`zod`, `dotenv`**, modular `src/` folders. Build it in **phases** — same as poli_bot
started with data collection.

```
binance_bot/
  src/
    config.ts            # env + zod-validated config, per-playbook params
    logger.ts            # structured logging (copy poli_bot)
    types.ts             # Candle, Signal, Trade, Position, Playbook enums
    exchange/
      binance.ts         # REST + WS wrapper (ccxt or native) — testnet aware
      marketData.ts      # klines fetch, funding, mark price, symbol filters
      account.ts         # balance, positions, leverage, margin
    storage/
      db.ts              # sqlite schema + migrations
      candles.ts         # OHLCV cache
      trades.ts          # trade journal (entry/exit/R/fees/funding)
    indicators/
      ta.ts              # EMA, ATR, RSI, ADX, swing highs/lows, donchian
    universe/
      scanner.ts         # pick tradable symbols (volume, volatility filters)
    playbooks/
      types.ts           # Playbook interface: detect(candles, ctx) -> Signal|null
      trendPullback.ts   # the money-maker — build first
      trendBreakout.ts
      volatility.ts      # build later / optional
    risk/
      sizing.ts          # R-based position sizing from stop distance
      manage.ts          # TP1/2/3, breakeven, managed/health stops
    engine/
      loop.ts            # scan -> signal -> size -> execute -> manage
      paperBroker.ts     # simulated fills for paper trading
      liveBroker.ts      # real Binance orders (guarded behind flags)
    backtest/
      runner.ts          # replay candles, simulate fills, fees, funding
      metrics.ts         # win rate, expectancy, maxDD, Sharpe, per-playbook
    notifications/
      telegram.ts        # trade/error alerts (optional)
    scripts/
      collect.ts         # download + cache klines (PHASE 1)
      backtest.ts        # run a playbook over history (PHASE 2)
      paper.ts           # live paper trading (PHASE 3)
      live.ts            # real trading, tiny size (PHASE 4)
  data/                  # sqlite db + downloaded klines
  .env / .env.example
  package.json
```

### Tech choices
- **Exchange lib:** **Native Binance USDT-M Futures API** (`fapi` REST + WS) — chosen
  for full control and no abstraction layer. We'll write a thin typed wrapper in
  `exchange/binance.ts`: signed REST (HMAC-SHA256), klines/funding/mark-price reads,
  and order endpoints. Implications to handle ourselves (ccxt would have hidden these):
  - **Auth:** HMAC-SHA256 signing of query strings, `recvWindow`, server-time sync.
  - **Symbol filters:** parse `exchangeInfo` for tickSize / stepSize / minNotional and
    round prices & quantities before sending (else `-1111`/`-2010` rejects).
  - **Rate limits:** track `X-MBX-USED-WEIGHT`; cache klines hard (cheap on 1h bars).
  - **Testnet:** different base URLs (`testnet.binancefuture.com`) — make base URL configurable.
  - **WS:** user-data stream (listenKey + keepalive) for fills, and mark-price/kline streams.
- **DB:** `better-sqlite3` (same as poli_bot) — synchronous, simple, perfect for this.
- **Why TS:** reuse poli_bot patterns, your familiarity, strong typing for money code.

---

## 3. Strategy: the `trend-pullback` playbook (build this first)

This is the one that makes money in the reference bot. Concrete, testable rules
(tune in backtest — these are sensible starting defaults):

**Context filter (per symbol, 1h):**
- Trend = EMA(50) vs EMA(200): `up` if EMA50 > EMA200, `down` if below.
- Only take trades in the trend direction (long in uptrend, short in downtrend).
- Optional strength gate: `ADX(14) >= 20` to avoid chop (this is what kills the
  bot in ranging markets — worth testing).

**Entry (long example; mirror for short):**
- Price pulls back to EMA(20) or a recent swing/Fib zone while trend stays up.
- Trigger: bullish reversal candle (e.g. close back above EMA20, or RSI(14)
  crosses up from <40) → enter long.

**Stop & risk:**
- Initial stop = `entry − k * ATR(14)` (k ≈ 1.5), or just beyond the pullback swing low.
- `1R = entry − stop` (the risk per unit).
- Size so that **risk per trade = fixed % of equity** (start 0.5–1.0%, the ref bot
  risks tiny amounts: ~16–85 USDT position on ~370 equity).

**Exits (this is where the edge lives):**
- **TP1** at +1R → take 1/3 off, **move stop to breakeven** (now max loss ≈ 0).
- **TP2** at +2R → take 1/3 off.
- **TP3** at +3R (or trail the rest with a chandelier/ATR trail) → close remainder.
- **HEALTH_CLOSE**: exit if trend flips (EMA50 crosses EMA200 against you) or a time
  stop (e.g. N bars with no progress).
- **MANAGED_STOP**: the trailing stop after breakeven.

> The breakeven move after TP1 is the single mechanic that produces the
> "lose-often-still-profit" curve. Implement and test it carefully.

`trend-breakout` (Donchian/range breakout + retest) and `volatility` can come later;
they were net-negative in the reference window, so **don't prioritize them.**

---

## 4. Risk management (the part that keeps you solvent)

- **Risk per trade:** fixed fraction of equity (start 0.5%). `qty = (equity * risk%) / (1R per unit)`.
- **Leverage:** set per symbol only high enough to hold the position; keep **margin
  usage low** (ref bot sits at 4.4%). Leverage ≠ risk here — the stop defines risk.
- **Max concurrent positions:** cap (ref bot ran 3 open). Start with 2–3.
- **Max daily loss / kill switch:** halt new entries if equity draws down X% in a day.
- **Correlation guard:** don't take 5 longs on coins that all move together.
- **Account for fees + funding** in every PnL calc (ref bot: commission was −10.59 on
  +35.71 gross — **fees ate ~30% of gross**; on 1h trades this matters a lot).

---

## 5. Phased build plan

| Phase | Goal | Deliverable | Real money? |
|---|---|---|---|
| **0. Scaffold** | Project setup | `package.json`, config, db schema, types | No |
| **1. Data** | Reliable history | `collect.ts` downloads + caches 1h klines for ~60 symbols; funding history | No |
| **2. Backtest** | Prove the edge | `backtest.ts` runs `trend-pullback` over 1–2y; reports win%, expectancy, maxDD, **net of fees+funding**, per-playbook | No |
| **3. Paper** | Validate live plumbing | `paper.ts` runs the full loop on live data with simulated fills for 2–4 weeks; compare to backtest | No |
| **4. Live (tiny)** | Real edge check | `live.ts` on **Binance testnet first**, then real money at **minimum size** (e.g. risk $1–2/trade) | Yes, tiny |
| **5. Scale & dashboard** | Operate | Add the dashboard (Next.js, like the ref UI), alerts, scale risk slowly | Yes |

**Gate between phases:** do not advance until the prior phase's numbers are good.
Backtest expectancy must be clearly positive *after fees* before any live capital.

---

## 6. Binance specifics & gotchas
- Use **USDT-M Futures** (`fapi`), **one-way** position mode to start (simpler than hedge mode).
- **Test on Binance Futures testnet** first — full order flow without risk.
- Respect **symbol filters**: tick size, step size, min notional. ccxt exposes these;
  round prices/qty or orders get rejected.
- **Rate limits**: batch klines, cache aggressively (we're on 1h bars — cheap).
- **API key perms**: enable Futures trading, **disable withdrawals**, IP-whitelist the key.
- **Funding** is paid/received every 8h on perps — include in PnL and in hold-cost logic.
- **Geo/legal**: Binance access varies by jurisdiction — confirm yours.

---

## 7. Decisions made & open questions
**Decided:**
- **Exchange lib:** Native Binance USDT-M Futures API (no ccxt) — see §2.
- **Strategy source:** **Reverse-engineer** from the UI. We do *not* have the friend's
  exact rules, so the `trend-pullback` rules in §3 are our own hypotheses to be
  validated/tuned in backtest. Treat every parameter (EMA periods, ATR k, ADX gate,
  TP levels) as a knob, not gospel.

**Still open:**
1. **How much capital** for the live phase? (Sets risk-per-trade sizing.)
2. **Symbol universe:** which ~60 USDT-M perps? Start from top-volume liquid majors.
3. **Backtest data source:** Binance free historical klines (`data.binance.vision`) is best.

---

## 8. Immediate next step
Scaffold Phase 0 + Phase 1 (data collection) so we can start pulling history and
**backtest the `trend-pullback` playbook**. Everything downstream depends on
proving the edge on real data first.
```

# build the data collector → backtest trend-pullback → review numbers
```
```
