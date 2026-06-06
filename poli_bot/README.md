# trading_bot

A Polymarket BTC 5-minute up/down trading bot. Watches the price of Bitcoin and Polymarket's
prediction-market order book, computes a fair-value probability, and trades the gap. Built in
TypeScript.

> **Current status:** Phases 1–3 (data collection, fair-value model, paper trading) are fully
> working and risk **zero real money**. Phase 4 (live trading with real money) is built but not
> wired in yet — see "Going live" below.

For a deep dive on architecture, math, and design, see **[DOCS.md](DOCS.md)**.

---

## 1. What you need (prerequisites)

- **Node.js 20 or newer.** Check with `node --version`. If it's missing or older, install from
  [nodejs.org](https://nodejs.org).
- An empty wallet — that is, **no Polymarket account is required for Phases 1–3**. You only need it
  when you decide to trade with real money.
- A computer that can stay on for at least a few hours (you'll want overnight data eventually).

---

## 2. First-time setup (one-time)

Open a terminal in the `trading_bot` folder and run:

```bash
# 1. Make your own copy of the configuration file
cp .env.example .env

# 2. Install the JavaScript dependencies
npm install

# 3. Make the folder where the database will live
mkdir -p data
```

That's it for setup. Your `.env` file already has sensible defaults so you don't need to edit it
yet.

---

## 3. Quick sanity check (30 seconds)

Before running the bot for real, confirm everything connects to the outside world. Run these two
commands one at a time:

### 3a. Check Polymarket discovery

```bash
npm run discover
```

You should see something like:

```
[info] Scanning Polymarket BTC 5m series (10684)...
[info] Found 20 upcoming events
[info]  - btc-updown-5m-1779978900 ends: 2026-05-28T14:40:00.000Z
...
[info] Current event: { slug: 'btc-updown-5m-1779978900', ... }
[info] UP orderbook:   { bestBid: 0.52, bestAsk: 0.53, mid: 0.525, ... }
[info] DOWN orderbook: { bestBid: 0.47, bestAsk: 0.48, mid: 0.475 }
[info] Sum of mids (sanity check, should ≈ 1): 1.0000
```

**What to check:** the script finds an open 5m market and prints UP/DOWN prices. The sum of mids
should be very close to `1.0000`. If it errors out, your internet might be blocking Polymarket —
try again from a different network.

### 3b. Check Binance BTC feed

```bash
npm run btc-feed
```

You should see a flood of lines like:

```
[info] BTC tick { ts: '2026-05-28T14:38:21Z', price: 72915.41, bid: 72915.4, ask: 72915.41, ... }
```

Real-time BTC prices streaming in. Press `Ctrl+C` to stop after ~10 seconds.

If both commands work — you're ready.

---

## 4. Start the bot (data collection + paper trading)

```bash
npm run collect
```

This is the **main process**. It does everything at once:

- Polls Polymarket every 5 seconds for current order book
- Streams BTC prices from Binance continuously
- Computes the fair-value probability (after ~3 minutes of warm-up for volatility)
- Decides whether to open a **paper trade** (no real money) and logs it
- Settles paper positions when each 5m window resolves
- Writes everything to `data/ticks.sqlite`

**What you'll see in the first minute:**
```
[info] Starting trading bot
[info] Strategy params: { bankrollUsd: 1000, ... }
[info] Risk limits: { maxOpenPositions: 3, maxRiskPerTradeUsd: 5, ... }
[info] Binance WS connected
[info] New window { slug: 'btc-updown-5m-...', end: '...' }
```

**What you'll see after 3+ minutes (once volatility is computed):**
Whenever the strategy finds an edge ≥ 5%, you'll see:
```
[info] paper OPEN {
  id: '1',
  side: 'UP',
  slug: 'btc-updown-5m-...',
  price: 0.55,
  shares: '9.09',
  risk: '$5.00',
  maxProfit: '+$3.91',
  maxLoss: '-$5.00'
}
```

**What you'll see when a 5m window closes:**
```
[info] Window closed { slug: '...', open: 72850, close: 72895, up: true, paperSettled: 1 }
[info] paper CLOSE { id: '1', side: 'UP', win: true, pnl: '3.91' }
```

**To stop:** press `Ctrl+C`. Your data is safe — restarting just appends more.

> 💡 **Tip:** leave this running for **at least 24 hours** to gather a meaningful dataset before
> drawing conclusions about the strategy. Many trading edges look great in 10 minutes and
> disappear after a day.

---

## 5. See how the strategy is performing

While the collector is running (or after stopping it), open a **new terminal** and run:

```bash
npm run backtest
```

This replays every tick logged so far through the strategy and prints something like:

```
[info] Backtest result {
  trades: 142,
  resolved: 138,
  skippedNoOutcome: 4,
  wins: 76,
  winRate: '55.1%',
  totalRiskUsd: '710.00',
  totalPnlUsd: '+38.42',
  roi: '+5.41%'
}
```

### How to read this

- **`trades`** — how many bets the strategy would have placed.
- **`winRate`** — % of trades that won. For a 50/50 underlying market, anything **above ~52%** is
  promising (you need to beat the 2% taker fee).
- **`totalPnlUsd`** — total simulated profit in USD across all the trades.
- **`roi`** — return-on-risk. `+5%` ROI on dozens of trades = signs of real edge. **Negative ROI =
  the strategy needs tuning before going live.**

### Inspect the database directly (optional)

```bash
sqlite3 data/ticks.sqlite

# how many ticks have you logged?
SELECT COUNT(*) FROM ticks;

# how is the model's predicted P(Up) distributed?
SELECT ROUND(fair_value_up, 1) AS bucket, COUNT(*) FROM ticks
  WHERE fair_value_up IS NOT NULL GROUP BY bucket;

# what was the win-rate of your paper trades?
SELECT side, COUNT(*) AS trades, AVG(win) AS win_rate, SUM(realized_pnl_usd) AS total_pnl
  FROM paper_trades WHERE win IS NOT NULL GROUP BY side;

.quit
```

---

## 6. Tuning the strategy

Open `.env` and change any of the values — see the inline explanations there. Each parameter has a
"higher = X, lower = Y" hint right above it. The most impactful ones to play with:

- **`STRATEGY_MIN_EDGE`** (default `0.05`) — raise to `0.07` for fewer but higher-conviction trades.
- **`STRATEGY_KELLY_FRACTION`** (default `0.25`) — keep at `0.25` until backtest shows ≥1000 trades.
- **`RISK_MAX_PER_TRADE_USD`** (default `5`) — start small; raise gradually if backtest is positive.

After changing `.env`, stop the collector (`Ctrl+C`) and restart it.

---

## 7. Going live (Phase 4) — REAL MONEY

**Triple-safety design.** Three flags must align before any real order is placed:
1. `POLYMARKET_PRIVATE_KEY` must be set
2. `LIVE_TRADING=true` must be set
3. `LIVE_DRY_RUN=false` must be set

If any one is missing, the bot stays in paper mode. Default `.env` has all three OFF.

### Step-by-step

#### 1. Create a dedicated wallet (1 minute)

In MetaMask (or any wallet): create a brand-new account. **Do not reuse a wallet that holds anything else.** Copy the address and private key somewhere safe.

#### 2. Fund it on Polygon

You need three things in the wallet:
- **USDC** on Polygon — $10–20 to start
- **MATIC** on Polygon — $1–2 (gas, only ~$0.01 per tx)
- **pUSD** (Polymarket's collateral token, 1:1 backed by USDC) — created by wrapping your USDC

To get pUSD: send USDC to the wallet, then sign in to [polymarket.com](https://polymarket.com) with that wallet. The UI will detect your USDC and prompt you to wrap it to pUSD with one signature (1:1, no fee). After wrapping, your pUSD balance is what the bot can trade.

#### 3. Configure `.env`

```env
POLYMARKET_PRIVATE_KEY=0x<your-private-key>
POLYMARKET_FUNDER_ADDRESS=0x<your-wallet-address>

# Phase 4 flags — keep these conservative
LIVE_TRADING=false      # leave false for now
LIVE_DRY_RUN=true       # leave true for now
LIVE_MAX_TRADE_USD=2    # hard cap per trade
```

#### 4. Verify auth (no orders placed)

```bash
npm run live-smoke-test
```

Should print your wallet address, USDC balance, and allowances. If allowances are empty, the bot will set them automatically on the first real order (one-time gas cost on Polygon, < $0.01).

#### 5. Place one tiny test order

```bash
LIVE_DRY_RUN=false npm run live-test-order
```

This places **one $2 max** BUY order at the best bid (passive — likely won't fill, just verifies signing works). After 60 seconds the script exits. Cancel the order in the Polymarket UI if it's still open.

#### 6. Watch the order on Polymarket

Open [polymarket.com](https://polymarket.com), sign in with the same wallet, navigate to "Portfolio" → "Open Orders". You should see your test order. If you see it: auth is working. ✅

#### 7. Enable live trading

In `.env`:
```env
LIVE_TRADING=true
LIVE_DRY_RUN=true   # KEEP THIS true for the first run
```

Run `npm run collect` again. The bot will now log what it WOULD have placed for real. Watch a few windows to confirm sanity.

#### 8. Go live (smallest possible)

Once dry-run looks correct:
```env
LIVE_DRY_RUN=false
LIVE_MAX_TRADE_USD=2
```

Restart `npm run collect`. **First few trades: watch every single one.** If anything looks wrong, `Ctrl+C` immediately and inspect.

---

## Available commands (cheat sheet)

| Command | What it does |
|---|---|
| `npm run discover` | One-shot: list current 5m markets + show their order books |
| `npm run btc-feed` | One-shot: confirm Binance WebSocket connection |
| `npm run collect` | **Main process.** Logs ticks + runs paper trades. Keep running. |
| `npm run backtest` | Replay logged data through the strategy and print P&L |
| `npm run backfill` | Backfill Polymarket-confirmed outcomes for already-logged windows |
| `npm run live-smoke-test` | Verify auth + USDC balance (places NO orders) |
| `npm run live-test-order` | Place ONE $2 test order to verify live execution |
| `npm run typecheck` | Confirm the TypeScript compiles cleanly |

---

## Common questions

**Q: Do I need money to start?**
A: No. Phases 1–3 (everything you see above) run with **zero real money**. Only Phase 4 (live
trading) needs funded USDC.

**Q: What if I stop and restart `collect`?**
A: It's safe — the SQLite database appends. Your old data is preserved.

**Q: I see `realized_vol_1m` is NULL in my ticks.**
A: The volatility calculator needs ~3 minutes of BTC price data to warm up. Just let it run.

**Q: I don't see any paper trades after 10 minutes.**
A: That's normal — the strategy is conservative. Trades only open when fair-value edge ≥ 5%. If
none show after a few hours, lower `STRATEGY_MIN_EDGE` in `.env` (try `0.03`) to see more.

**Q: How much disk space does this use?**
A: Roughly 1 MB per day of `collect`. Trivial.

---

For the full architecture, math behind the model, database schema, and tuning theory, read
[DOCS.md](DOCS.md).
