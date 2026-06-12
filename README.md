# Binance Futures Bot

A systematic **Binance USDT-M perpetual futures** bot (long/short, 1h timeframe), reverse-engineered
from a friend's profitable bot. R-based risk, scaled take-profits + a trailing runner, and an
intra-minute safety guardian.

> **Status (2026-06-12):** **LIVE on mainnet at tiny size** (~$1k, 1% risk, notional cap 50% of equity/leg),
> forward-testing the §2 sweep-winner config. The edge is **thin (walk-forward PF 1.02–1.13) and
> only replay-validated — not yet proven live**. See [§7 The honest risk picture](#7-the-honest-risk-picture--read-before-going-live).

This is the single design/status doc. For the day-to-day code map and non-obvious invariants, see
[CLAUDE.md](CLAUDE.md).

---

## 1. What it is & where the edge comes from

A trend-following bot that **loses often but small, and wins rarely but big**. The edge is **payoff
asymmetry, not hit rate**:

```
Win rate ~50%  ·  avg loss ≈ −1R  ·  avg winner runs to +2R and beyond
→ expectancy is positive because winners are bigger than losers
```

It runs **one playbook: `trend-pullback`** (enter on a pullback within an established trend). The
reference bot ran several playbooks but one carried the book; our backtests confirmed `trend-breakout`
is net-negative and *crowds out* pullback's good trades, so it stays disabled.

---

## 2. Status & current config

Live on mainnet (tiny size) since 2026-06-10. The config below is the **2026-06-10 sweep
winner** (`npm run sweep`: 72 combos × 2 walk-forward splits on the live 45-symbol universe,
finals judged under `LIVE_SIM` — the only combo positive on train AND OOS on both splits):

| Knob | Value | Why |
|---|---|---|
| `ADX_MIN` | `35` | selective entries — every robust sweep config used 35 (25 was −EV here) |
| `ATR_MULT` | `1.5` | initial stop; with the guardian ACTIVE 1.5 beats 2.0 (flip-exit absorbs whipsaw) |
| `TAKE1` / `TAKE2` | `0` / `0.5` | nothing at +1R, half at +2R, **trail the rest** — riders carry the edge |
| `MAX_HOLD_BARS` / `STALL_BARS` | `12` / `12` | short time-stops pair with the selective ADX35 gate |
| `TRAIL_MULT` | `3` | runner trails 3×ATR behind the peak (2× backtested worse) |
| `COOLDOWN` | `6` | bars to wait per symbol after a close |
| `MAX_OPEN_POSITIONS` | `4` | caps correlated exposure — a top risk lever (see §6) |
| `RISK_PCT` / `RISK_USDT` | `1%` / `0` | risk per trade |
| `MAX_NOTIONAL_PCT` | `0.5` | notional/leg ≤ 50% of CURRENT equity — self-scales with the account (gap-through-stop loss scales with NOTIONAL, not planned risk; the risk-based sizer can otherwise blow notional past 2× equity on tight stops) |
| `LEVERAGE` | `10` | risk is set by the stop, not leverage; keep margin usage low |
| `MAX_DAILY_LOSS_PCT` | `0.05` | kill switch — **halts new entries** past −5% on the day |
| `MONITOR_ENABLED` / `_INTERVAL_MIN` | `true` / `1` | the intra-minute guardian (§4) |
| `MONITOR_REVERSAL_MODE` / `_TF` | `exit` / `15m` | auto-close on a 15m reversal (`off` / `warn` / `exit`) |

**Walk-forward numbers** (LIVE_SIM, 45 symbols): split1 train +$33 / OOS +$134 (PF 1.13);
split2 +$64 / +$53; Apr'26→now +$220, PF 1.62, DD 8.5%. **Daily expectations on a ~$1k
account** (replay distribution, NOT a promise): recent regime mean ≈ +0.7%/day, median +0.2%,
typical day −1.7%..+4.5%, worst −4.1%; the conservative longer window is mean +0.2%/day with
only ~45% green days — profits concentrate in a few good days. The edge is THIN (WF PF
1.02–1.13); the PF 1.62 is the current chop regime, don't anchor on it.

---

## 3. The strategy & exit model

### Entry — `trend-pullback`
- **Trend:** EMA50 vs EMA200 on the 1h. Long only in an uptrend, short only in a downtrend.
- **Gate:** `ADX(14) ≥ 35` (avoid sideways chop — raised from 25 in the 2026-06-10 sweep).
- **Trigger:** price pulls back to EMA20 and reclaims it with a reversal candle in the trend direction.
- **Stop:** `entry ∓ 1.5×ATR(14)`. That entry-to-stop distance **is 1R** — the unit everything is measured in.

### Exit — the scaled ladder (where the edge lives)
| Stage | Trigger | Action | Stop moves to |
|---|---|---|---|
| **TP1** | +1R | sell 0 (skip — current config) | **breakeven** (capital safe) |
| **TP2** | +2R | sell 0.5 | **+1R** (profit locked) + arm the trail |
| **Runner** | — | last 0.5 **trails** | chandelier: `peak ∓ 3×ATR`, ratchets one way only |

So a typical winner (current `TAKE1=0 / TAKE2=0.5`): `0.5×(+2R) + 0.5×(runner)`. Once TP2 hits,
the runner can only win between +1R and +∞. A trade stopped before TP1 loses **−1R**. (The TP
fractions are `.env` knobs — the §2 table is the source of truth.)

Other exits: **HEALTH_CLOSE** (1h trend flips against the position), **STOP** / **MANAGED_STOP** (the
protective/trailing stop).

---

## 4. The guardian (intra-minute safety) — live-only

The TP ladder above runs **once per hour** on candle close (the backtest-faithful path). Between those
ticks, a fast **guardian** checks every open position **every minute**:

- **Layer A — enforce the stop on the live price.** If the mark has crossed `pos.stop`, close
  immediately (`GUARDIAN_STOP`) instead of waiting up to an hour. This fixes the gap on the demo venue,
  which rejects resting stop orders — so without it, price can blow past the stop unprotected.
- **Layer B — exit on a faster-timeframe reversal.** If the **15m** EMA50/EMA200 flips against a
  *not-yet-locked* position (`!tp2Hit`), auto-close it (`REVERSAL_CLOSE`) and Telegram an alert. It never
  cuts a locked, trailing runner. Modes: `off` / `warn` (alert only) / `exit` (auto-close).

One process, one loop — the hourly tick and the guardian never run concurrently, so there's no
DB contention. **Layer A is backtest-neutral** (the backtest already assumes intra-candle stops);
**Layer B is a deliberate live-only overlay** the 1h backtest can't model, journalled with its own close
reasons so its impact can be measured.

---

## 5. Commands

| Command | Purpose | DB |
|---|---|---|
| `npm run collect` | Download/cache 1h klines for the universe (`TIMEFRAME=15m` → 15m candles for LIVE_SIM) | `binance.sqlite` |
| `npm run collect-funding` | Download 8h funding history (accurate backtest costs) | `binance.sqlite` |
| `npm run backtest` | Replay candles through the engine; win%, expectancy, PF, maxDD, daily-PnL distribution, by-close-reason, net of fees. `TRAIN_END=YYYY-MM-DD` → walk-forward | `binance.sqlite` |
| `npm run optimize` | Walk-forward grid search over playbook knobs (select on TRAIN, report TEST) | `binance.sqlite` |
| `npm run sweep` | Walk-forward sweep over ATR_MULT × TP profile × time-stops × ADX (the levers optimize misses); honors `LIVE_SIM` | `binance.sqlite` |
| `npm run scan` | "Why is the bot not trading?" — run the REAL detect() on the CURRENT market and show each symbol's first blocking gate (ADX/pullback/reclaim) | — |
| `npm run mfe` | MFE/MAE path autopsy — hour-by-hour excursion after every entry, winners-vs-losers peaks, and the time-stop "would holding longer have rescued it?" counterfactual. `MFE_SOURCE=live` for the real journal | `binance.sqlite` |
| `npm run testnet` | **Forward-test** — live engine on the demo venue: hourly tick + 1-min guardian | `testnet.sqlite` |
| `npm run live` | Real money (mainnet). Refuses unless `ALLOW_LIVE=true` **and** `CONFIRM_LIVE=true` | `live.sqlite` |
| `npm run dashboard:testnet` / `:live` | Read-only ops dashboard (localhost:8787 / :8788) | testnet / live |
| `npm run account` / `flatten` | Print balances+positions / emergency close-all | testnet / live |
| `npm run typecheck` | `tsc --noEmit` — the only static gate (no test runner) | — |
| `npx tsx src/scripts/check-manage.ts` | Deterministic assertions for the exit engine (TP/stop/trail math) | — |
| `npx tsx src/scripts/check-detect.ts` | Deterministic assertions for the ENTRY engine (trend/reclaim/ADX/slope gates, stop/TP geometry) | — |
| `npx tsx src/scripts/check-ta.ts` | Sanity-check the indicators against hand calcs | — |

Engine env flags (prefix a `testnet`/`live` run): `RUN_NOW=true`, `ONESHOT=true`, `DRY_RUN=true` (use a
throwaway `DB_PATH`!), `NO_STREAM=true`.

### Backtest ↔ live parity (LIVE_SIM) — how to make the replay match `npm run live`

By default `npm run backtest` replays the PURE candle-close engine over EVERY symbol in the
research DB — that is **not** what live does. Two flags close the gap (2026-06-10):

```bash
LIVE_SIM=true BACKTEST_SYMBOLS=env npm run backtest          # the closest replay of live
LIVE_SIM=true BACKTEST_SYMBOLS=env EQUITY=1050 FROM=2026-06-10 npm run backtest  # vs your journal
```

- `BACKTEST_SYMBOLS=env` → trade only the live `SYMBOLS` universe, scanned in the same order
  (slot contention picks the same winners). Default = all ~69 DB symbols, which flatters results.
- `LIVE_SIM=true` → simulate the live execution overlay: the guardian's 15m trend-flip exit
  (`REVERSAL_CLOSE`, pre-TP2 — the dominant live exit), intra-bar stop ordering, TP1/TP2 fills
  at the bar CLOSE (live TPs are market orders on the tick), and the M8 sizing caps. Needs 15m
  candles (`TIMEFRAME=15m npm run collect`). The flip predicate lives in ONE module
  (`src/risk/guardian.ts`) shared by the live monitor and the sim, so they cannot drift.
- What still differs (~5-10% noise): real per-order slippage vs the fixed 2bps, mark-vs-last
  price stop triggers, ~15s entry latency, partial fills. Decisions match ~99%; per-trade
  prices wobble; aggregates converge over 100+ trades.
- **Judge every config with LIVE_SIM** — the guardian overlay flips verdicts (e.g. it is
  net-negative across the full history but net-positive in chop regimes, and ATR 1.5 beats
  2.0 only when the guardian is active). Parity check after a few live weeks: compare the
  journal vs `LIVE_SIM=true BACKTEST_SYMBOLS=env FROM=<go-live date>` — trade count, win
  rate, the **By close reason** mix, and net should land within ~10-15%.

---

## 6. Architecture (brief)

The decisive rule: **one shared logic path** — the pure decision functions are used verbatim by the
backtest, testnet, and live. Change exit/sizing/signal logic in the shared functions, never duplicate it.

- `playbooks/trendPullback.ts` — `detect()` entry signals
- `risk/sizing.ts` — `sizePosition()` (R-based) + `splitTranches()` (step-rounded TP fractions)
- `risk/manage.ts` — `manageOnCandle()`, the TP ladder / breakeven / trail / health-close machine
- `backtest/runner.ts` — vectorized replay; `engine/loop.ts` — the live engine (calls the *same* functions)
- `engine/loop.ts` — `runScheduled` (dual cadence), `monitorOpenPositions` (the guardian)
- `engine/{liveBroker,paperBroker}.ts` — execution behind one `Broker` interface (venue chosen by the npm command)

Stack: Node ≥20, ESM, TypeScript via `tsx` (no build step). `better-sqlite3` (three DBs: `binance` =
research, `testnet`, `live`). Config flows `env → config.ts → typed config`. Deep invariants live in
[CLAUDE.md](CLAUDE.md).

---

## 7. The honest risk picture — read before going live

**This is the most important section.** Updated 2026-06-10 after the LIVE_SIM parity work — earlier
headline numbers (run on the ~69-symbol research DB with no guardian) flattered the picture:

- **On the TRUE live universe (45 symbols, judged under LIVE_SIM) no config shows a full-range
  edge.** The §2 sweep winner is the only combo positive on train AND OOS on both walk-forward
  splits — at **thin PF 1.02–1.13**. The strong recent numbers (PF ~1.6–1.9, Apr'26→now) are the
  current chop regime, not the expectation.
- **The guardian's flip-exit cuts both ways**: net-negative across the full history (truncates
  winners), net-positive in chop regimes — which is why every config decision must be judged with
  `LIVE_SIM=true`, never the bare replay.
- **`MAX_OPEN_POSITIONS=4` re-validated under LIVE_SIM (2026-06-10)**: 4 is the only value ✅both on
  both splits; 6 and 8 flip negative and balloon max DD from ~40% to ~65% — extra slots only fill
  in correlated signal bursts, the exact moments stacking hurts.
- **Daily reality on a ~$1k account** (replay distribution): mean +0.2–0.7%/day depending on regime,
  roughly **half of days red or flat**, typical day −1.7%..+4.5%, worst ~−5%. Profit concentrates in
  a few good days — judge over weeks, not days.

**What "safe" does and doesn't mean here:**
- **Realized loss is ~1.1–1.3R, not exactly 1R** — slippage widens the stop distance from the fill, and
  taker fees are a real fraction of R on tight stops (the backtest models both — it's the cost reality).
- **The kill switch caps *new entries*, not *loss*.** With 4 open positions each able to ride to −1R, a
  bad day can exceed the 5% "cap". It's an entry gate, not a hard stop on the day.
- **On the demo venue the guardian is the *only* stop enforcer**, so a fast gap between 1-min checks fills
  worse than 1R. On mainnet the resting exchange stop covers this.
- **The live journal omits funding** on multi-day runners (equity is correct; per-trade R reads slightly
  optimistic).

**Discipline:** live runs at 1% risk + the `$500` notional cap (the cap binds on tight ATR-1.5 stops,
so EFFECTIVE risk per trade is ~0.3–0.5%). Scale risk and cap **as a pair** (cap ≈ 0.5× equity) only
after ≥4 weeks AND ≥50 live trades AND the live↔LIVE_SIM parity check holds — and be willing to walk
away if the edge isn't there.

---

## 8. How it was built (milestones — all done)

Built in gated phases; each gate had to pass before advancing. Summary:

| M | Step | Gate |
|---|---|---|
| M0 | Scaffold (config, types, logger) | typecheck passes |
| M1 | Exchange read layer (klines, exchangeInfo, funding) | fetch BTC candles |
| M2 | Storage (SQLite + `collect`) | 1y data, ~50 coins, idempotent |
| M3 | Indicators (EMA/ATR/ADX/Donchian) | match hand calcs |
| M4 | Strategy (`trend-pullback`) | sensible signals |
| M5 | Risk: sizing + `manageOnCandle` | qty/margin correct |
| **M6** | **Backtest engine** ⭐ | **+EV after fees, out-of-sample** |
| M7 | Live on testnet (forward-test) | full lifecycle OK; live ≈ backtest |
| M8 | Live real money, tiny size | real +EV → scale |
| M9 | Dashboard + ops (alerts, backups) | observable |

**2026-06 improvements** (on top of M0–M9): the intra-minute guardian; `MAX_OPEN_POSITIONS` 10 → 4;
the 2026-06-10 sweep-winner config (ADX 35, ATR 1.5, TP `0/0.5`, time-stops 12/12 — see §2); live-money
hardening from a full audit (partial-fill orphan guards, ambiguous-order recovery by clientOrderId,
adopt-filled-entries, strict env flags, BNB-fee estimates); **LIVE_SIM** (the backtest replays the
guardian + TP-at-close + live sizing caps — see §5) with `npm run sweep` for walk-forward config search;
and a dashboard rebuilt around decision metrics (gross exposure, kill-switch proximity, by-close-reason,
time-stop bar counts). The entry, exit, and indicator engines are covered by deterministic assertions
(`check-detect.ts`, `check-manage.ts`, `check-ta.ts` — all green).

---

## 9. Binance specifics & gotchas
- **USDT-M Futures** (`fapi`), **one-way** position mode (enforced at startup).
- The **demo/testnet venue** (`demo-fapi.binance.com`) rejects resting `STOP_MARKET` orders — hence the
  guardian. Its prices are the demo market's own (won't match mainnet).
- Conditional orders (STOP/TP) moved to the **Algo endpoint** (`/fapi/v1/algoOrder`) in 2025-12 — affects
  mainnet too.
- **Round prices to tick / qty to step** before sending (`roundToTick`/`roundToStep`) or orders reject.
- **Funding** settles every 8h on perps — modeled in backtest/paper; the exchange charges it directly on live.
- **API keys:** enable Futures, **disable withdrawals**, IP-whitelist. Mainnet `live` needs two flags
  (`ALLOW_LIVE` + `CONFIRM_LIVE`) plus a countdown.
