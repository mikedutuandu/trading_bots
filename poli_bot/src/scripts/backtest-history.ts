/**
 * Historical backtest + config sweep over ./data/history.sqlite (backfilled Polymarket windows).
 *
 *   npm run backtest-history                 # baseline (current config) + sweep, train/test split
 *   npm run backtest-history -- --split 0.75 # fraction of (older) windows used for training
 *
 * Replays the SAME decision code the live path uses (fairValue -> blendWithMarket -> decide ->
 * kellyRiskUsd -> live-sizing caps), reconstructing each input from:
 *   - the backfilled 1-min odds path (hist_prices)  -> market mid; ask modeled as mid + half-spread
 *   - 1-min BTC klines (hist_klines)                -> spot (intra-min interpolated), strike, vol
 *
 * HONEST LIMITS (vs live): ~5-6 market points/window (1-min, not 5s); no real bid/ask/spread, so
 * the entry price is mid + a MODELED half-spread; the maxSpread filter is inert here. Treat the $
 * P&L as indicative, and trust the TRAIN-vs-TEST gap more than any single in-sample number.
 *
 * Anti-overfit: configs are ranked by TRAIN net P&L, then their HELD-OUT TEST P&L is shown next to
 * it. A config that only shines in-sample is noise — that gap is the most important output here.
 */
import { config } from "../config.js";
import { fairValue, blendWithMarket } from "../analysis/fairvalue.js";
import { decide } from "../strategy/signal.js";
import { kellyRiskUsd } from "../strategy/sizing.js";
import { RollingRealizedVol } from "../btc/volatility.js";
import { getHistoryDb } from "../storage/history-db.js";

// No real book history: model the ask as mid + half-spread. Live observed ~0.01 full spread.
const MODEL_HALF_SPREAD = Number(process.env.HIST_MODEL_HALF_SPREAD ?? 0.005);
// Ranking ignores configs with fewer than this many train trades (small samples are noise).
const MIN_TRADES_FOR_RANK = Number(process.env.HIST_MIN_TRADES ?? 80);
// Contrarian mode: when the signal says UP, bet DOWN (and vice-versa). For testing "do the opposite".
const INVERT = process.env.INVERT === "1" || process.env.INVERT === "true";

interface Win {
  startTs: number;
  endTs: number;
  outcomeUp: number;
  strike: number;
  points: { t: number; p: number }[];
}

interface Cfg {
  minEdge: number;
  maxEdge: number;
  minEntryPrice: number;
  maxEntryPrice: number;
  minFvUp: number;
  maxBtcMovedPct: number;
  minBtcMovedPct: number;
  requireTrendAgreement: boolean;
  marketWeight: number;
  upOnly: boolean;
  maxVol: number;
  minRemainingSec: number;
  maxRemainingSec: number;
}

const BASE: Cfg = {
  minEdge: config.strategy.minEdge,
  maxEdge: config.strategy.maxEdge,
  minEntryPrice: config.strategy.minEntryPrice,
  maxEntryPrice: config.strategy.maxEntryPrice,
  minFvUp: config.strategy.minFvUp,
  maxBtcMovedPct: config.strategy.maxBtcMovedPct,
  minBtcMovedPct: config.strategy.minBtcMovedPct,
  requireTrendAgreement: config.strategy.requireTrendAgreement,
  marketWeight: config.strategy.marketWeight,
  upOnly: config.strategy.upOnly,
  maxVol: config.strategy.maxVol,
  minRemainingSec: config.strategy.minRemainingSec,
  maxRemainingSec: config.strategy.maxRemainingSec,
};

interface Result {
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  risk: number;
  roi: number;
  avgEdge: number;
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

// ---- Load + precompute (shared across every config in the sweep) ----
const db = getHistoryDb();

const klOpen = new Map<number, number>();
const klClose = new Map<number, number>();
const volAt = new Map<number, number>();
const driftAt = new Map<number, number>();
{
  const rows = db.prepare(`SELECT minute_ts, open, close FROM hist_klines ORDER BY minute_ts ASC`).all() as {
    minute_ts: number; open: number; close: number;
  }[];
  const rv = new RollingRealizedVol(30);
  for (const k of rows) {
    klOpen.set(k.minute_ts, k.open);
    klClose.set(k.minute_ts, k.close);
    rv.push(k.minute_ts * 1000, k.close); // class buckets by minute => same as live's last-tick-per-minute
    const v = rv.annualizedVol();
    const d = rv.annualizedDrift();
    if (v !== null) volAt.set(k.minute_ts, v);
    if (d !== null) driftAt.set(k.minute_ts, d);
  }
}

function spotAt(t: number): number | null {
  // NO LOOKAHEAD: use the OPEN of the current minute (price at the minute boundary, which is <= t).
  // The minute CLOSE is up to 60s in the future relative to t, so interpolating toward it would let
  // the model peek at where BTC is heading — that manufactured the implausible win rate. With the
  // 1-min grid this leaves <=60s of staleness (lag is safe; lookahead is fatal).
  const m = Math.floor(t / 60) * 60;
  return klOpen.get(m) ?? null;
}

const wins: Win[] = [];
{
  const winRows = db.prepare(
    `SELECT window_start_ts, window_end_ts, outcome_up FROM hist_windows WHERE outcome_up IS NOT NULL ORDER BY window_end_ts ASC`,
  ).all() as { window_start_ts: number; window_end_ts: number; outcome_up: number }[];
  const ptStmt = db.prepare(`SELECT t, p FROM hist_prices WHERE window_end_ts = ? ORDER BY t ASC`);
  for (const w of winRows) {
    const strike = klOpen.get(w.window_start_ts); // window_start is minute-aligned
    if (strike === undefined) continue;
    const pts = (ptStmt.all(w.window_end_ts) as { t: number; p: number }[]).filter(
      (pt) => pt.t >= w.window_start_ts && pt.t <= w.window_end_ts && pt.p > 0 && pt.p < 1,
    );
    if (pts.length === 0) continue;
    wins.push({ startTs: w.window_start_ts, endTs: w.window_end_ts, outcomeUp: w.outcome_up, strike, points: pts });
  }
}

interface TradeRec { endTs: number; price: number; won: boolean; }

function runConfig(cfg: Cfg, subset: Win[], sink?: TradeRec[]): Result {
  let trades = 0, wins_ = 0, pnl = 0, risk = 0, edgeSum = 0;
  const maxRiskFraction = config.risk.maxRiskPerTradeUsd / config.strategy.bankrollUsd;
  const clamp = (x: number): number => Math.min(0.999, Math.max(0.001, x));
  for (const w of subset) {
    for (const pt of w.points) {
      const remainingSec = w.endTs - pt.t;
      if (remainingSec <= 0) continue;
      const spot = spotAt(pt.t);
      if (spot === null) continue;
      // NO LOOKAHEAD: vol/drift from the previous fully-completed minute (its close lands at the
      // current minute boundary <= t). Using the current minute would fold in its not-yet-seen close.
      const volMinute = Math.floor(pt.t / 60) * 60 - 60;
      const vol = volAt.get(volMinute);
      if (vol === undefined || !(vol > 0)) continue;
      const drift = driftAt.get(volMinute) ?? 0;
      const fvRaw = fairValue({ spot, strike: w.strike, remainingSeconds: remainingSec, annualizedVol: vol, drift: 0 });
      if (!fvRaw) continue;
      const hs = MODEL_HALF_SPREAD;
      const upMid = pt.p;
      const downMid = 1 - pt.p;
      const upQuotes = { bestBid: clamp(upMid - hs), bestAsk: clamp(upMid + hs), mid: upMid, spread: 2 * hs };
      const downQuotes = { bestBid: clamp(downMid - hs), bestAsk: clamp(downMid + hs), mid: downMid, spread: 2 * hs };
      const fv = blendWithMarket(fvRaw, upMid, cfg.marketWeight);
      const decision = decide({
        fair: fv, upQuotes, downQuotes,
        minEdge: cfg.minEdge,
        maxSpread: 0.05, // real spread unrecoverable; keep permissive so it never binds
        minRemainingSec: cfg.minRemainingSec, maxRemainingSec: cfg.maxRemainingSec, remainingSec,
        spot, strike: w.strike, annualizedDrift: drift,
        maxVol: cfg.maxVol, annualizedVol: vol, upOnly: cfg.upOnly, minFvUp: cfg.minFvUp,
        maxEdge: cfg.maxEdge, minEntryPrice: cfg.minEntryPrice, maxEntryPrice: cfg.maxEntryPrice,
        maxBtcMovedPct: cfg.maxBtcMovedPct, minBtcMovedPct: cfg.minBtcMovedPct,
        requireTrendAgreement: cfg.requireTrendAgreement,
      });
      if (!decision.side || decision.takerPrice === null) continue;
      // Contrarian mode: bet the OPPOSITE side, at THAT side's ask. The model edge on the flipped
      // side is (usually) negative, so Kelly would zero it out — size it flat instead, comparable
      // to a deliberate "always fade the signal" bettor.
      let side = decision.side;
      let takerPrice = decision.takerPrice;
      let sizingEdge = decision.edge;
      if (INVERT) {
        side = side === "UP" ? "DOWN" : "UP";
        const oppAsk = side === "UP" ? upQuotes.bestAsk : downQuotes.bestAsk;
        if (oppAsk === null) continue;
        takerPrice = oppAsk;
        sizingEdge = (side === "UP" ? fv.pUp : fv.pDown) - oppAsk;
      }
      const riskUsd = INVERT
        ? config.live.maxTradeUsd
        : kellyRiskUsd({
            bankrollUsd: config.strategy.bankrollUsd, edge: sizingEdge,
            takerPrice, maxRiskFraction, kellyFraction: config.strategy.kellyFraction,
          });
      if (riskUsd <= 1) continue;
      // SAME live sizing the real-money path uses: cap, 5-share minimum, reject overshoot.
      const cappedRiskUsd = Math.min(riskUsd, config.live.maxTradeUsd);
      const rawShares = cappedRiskUsd / takerPrice;
      const shares = Math.max(config.collector.polymarketMinShares, Math.ceil(rawShares * 100) / 100);
      const actualRiskUsd = shares * takerPrice;
      if (actualRiskUsd > config.live.maxTradeUsd * config.collector.liveSizeCapTolerance) continue;
      const won = (side === "UP" && w.outcomeUp === 1) || (side === "DOWN" && w.outcomeUp === 0);
      pnl += (won ? 1 : 0) * shares - shares * takerPrice; // fees = 0 (Polymarket charges no taker fee)
      risk += actualRiskUsd;
      edgeSum += sizingEdge;
      trades++;
      if (won) wins_++;
      sink?.push({ endTs: w.endTs, price: takerPrice, won });
      break; // one trade per window (first qualifying point), matching live
    }
  }
  return {
    trades, wins: wins_,
    winRate: trades > 0 ? wins_ / trades : 0,
    pnl, risk,
    roi: risk > 0 ? pnl / risk : 0,
    avgEdge: trades > 0 ? edgeSum / trades : 0,
  };
}

function fmt(r: Result): string {
  return `trades=${String(r.trades).padStart(4)}  win=${(r.winRate * 100).toFixed(1).padStart(5)}%  ` +
    `pnl=$${r.pnl.toFixed(2).padStart(8)}  roi=${(r.roi * 100).toFixed(1).padStart(6)}%  edge=${(r.avgEdge * 100).toFixed(1)}%`;
}

function product(grid: Record<string, unknown[]>): Record<string, unknown>[] {
  let out: Record<string, unknown>[] = [{}];
  for (const [k, vals] of Object.entries(grid)) {
    const next: Record<string, unknown>[] = [];
    for (const o of out) for (const v of vals) next.push({ ...o, [k]: v });
    out = next;
  }
  return out;
}

// ---- Run ----
const split = arg("split", 0.75);
const splitIdx = Math.floor(wins.length * split);
const train = wins.slice(0, splitIdx);
const test = wins.slice(splitIdx);

const span = (s: Win[]): string =>
  s.length ? `${new Date(s[0]!.startTs * 1000).toISOString().slice(0, 10)} .. ${new Date(s.at(-1)!.endTs * 1000).toISOString().slice(0, 10)}` : "—";

console.log(`\nWindows: ${wins.length} resolved  (half-spread modeled at ${MODEL_HALF_SPREAD})`);
console.log(`  TRAIN: ${train.length}  [${span(train)}]`);
console.log(`  TEST : ${test.length}  [${span(test)}]\n`);

console.log("=== BASELINE (current config) ===");
console.log(`  TRAIN  ${fmt(runConfig(BASE, train))}`);
console.log(`  TEST   ${fmt(runConfig(BASE, test))}\n`);
if (process.env.BASELINE_ONLY) { db.close(); process.exit(0); }

// Focused grid over the params most likely to define the edge. Others stay at current defaults.
const GRID: Record<string, unknown[]> = {
  minEdge: [0.03, 0.06, 0.10, 0.15],
  maxEdge: [0.15, 0.30, 0.60, 1.0],
  maxEntryPrice: [0.55, 0.65, 0.75, 1.0],
  minBtcMovedPct: [0, 0.0004, 0.001],
  requireTrendAgreement: [false, true],
  marketWeight: [0, 0.3],
};
const combos = product(GRID);
console.log(`=== SWEEP: ${combos.length} configs on TRAIN, then their held-out TEST P&L ===`);

const ranked = combos
  .map((overrides) => {
    const cfg: Cfg = { ...BASE, ...(overrides as Partial<Cfg>) };
    return { overrides, train: runConfig(cfg, train), test: runConfig(cfg, test) };
  })
  .filter((r) => r.train.trades >= MIN_TRADES_FOR_RANK)
  .sort((a, b) => b.train.pnl - a.train.pnl);

console.log(`(ranked by TRAIN net P&L; ${ranked.length}/${combos.length} configs had >= ${MIN_TRADES_FOR_RANK} train trades)\n`);
const top = ranked.slice(0, 15);
for (const r of top) {
  const o = r.overrides as Record<string, unknown>;
  const label = Object.entries(o).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`  ${label}`);
  console.log(`     TRAIN ${fmt(r.train)}`);
  console.log(`     TEST  ${fmt(r.test)}`);
}

if (top.length > 0) {
  const best = top[0]!;
  const heldUp = top.filter((r) => r.test.pnl > 0).length;
  console.log(`\n=== VERDICT ===`);
  console.log(`Best-on-TRAIN config: ${Object.entries(best.overrides).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`  TRAIN pnl=$${best.train.pnl.toFixed(2)} (roi ${(best.train.roi * 100).toFixed(1)}%)  ->  HELD-OUT TEST pnl=$${best.test.pnl.toFixed(2)} (roi ${(best.test.roi * 100).toFixed(1)}%)`);
  console.log(`  ${heldUp}/${top.length} of the top-15 train configs stayed POSITIVE on the held-out test set.`);
  console.log(`  (If that fraction is low and/or the best config's test P&L is negative, the 'edge' is overfit noise — do NOT take it live.)`);

  // --- Real-money simulation: the BEST config, FLAT stake, from a starting bankroll, on TEST. ---
  // Answers "if I trade $X flat from $Y, what actually happens?" using the held-out data only.
  const START = Number(process.env.SIM_START_USD ?? 30);
  const STAKE = Number(process.env.SIM_STAKE_USD ?? 5);
  const sink: TradeRec[] = [];
  runConfig({ ...BASE, ...(best.overrides as Partial<Cfg>) }, test, sink);
  sink.sort((a, b) => a.endTs - b.endTs);
  let bal = START, peak = START, maxDD = 0, ruinDay: string | null = null, placed = 0, wonN = 0;
  const byDay = new Map<string, number>();
  for (const t of sink) {
    const stake = Math.min(STAKE, bal);
    if (stake < 0.5) { ruinDay = ruinDay ?? new Date(t.endTs * 1000).toISOString().slice(0, 10); break; }
    const shares = stake / t.price;
    bal += (t.won ? 1 : 0) * shares - shares * t.price;
    placed++; if (t.won) wonN++;
    const day = new Date(t.endTs * 1000).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + ((t.won ? 1 : 0) * shares - shares * t.price));
    peak = Math.max(peak, bal);
    maxDD = Math.max(maxDD, peak - bal);
    if (bal < 0.5 && !ruinDay) { ruinDay = day; break; }
  }
  const days = [...byDay.values()];
  console.log(`\n=== REAL-MONEY SIM (best config, flat $${STAKE}/trade, start $${START}, HELD-OUT TEST only) ===`);
  console.log(`  trades placed: ${placed}   win rate: ${placed ? (100 * wonN / placed).toFixed(1) : "0"}%`);
  console.log(`  start $${START.toFixed(2)}  ->  end $${bal.toFixed(2)}   (net $${(bal - START).toFixed(2)} over ${byDay.size} days)`);
  console.log(`  max drawdown: $${maxDD.toFixed(2)}   ruin: ${ruinDay ? `YES, busted on ${ruinDay}` : "no"}`);
  if (days.length) {
    console.log(`  per-day P&L: best $${Math.max(...days).toFixed(2)}  worst $${Math.min(...days).toFixed(2)}  avg $${(days.reduce((s, x) => s + x, 0) / days.length).toFixed(2)}`);
    console.log(`  days hitting the +$30 target: ${days.filter((d) => d >= 30).length} / ${days.length}`);
  }
}

db.close();
