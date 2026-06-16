import Database from "better-sqlite3";
import { binance } from "../exchange/binance.js";
import { getKlines } from "../exchange/marketData.js";
import { ema } from "../indicators/ta.js";
import type { Candle } from "../types.js";

/**
 * Stop-loss autopsy — fine-grained (5m) reconstruction of every CLOSED live trade.
 *
 * Measures, per trade, in R units: MFE (best favorable excursion before close), MAE,
 * and whether price ever touched +0.5R / +0.75R / +1R before the −1R stop.
 *
 * Then it simulates candidate exit rules and reports the counterfactual R per trade,
 * so we can answer "would a faster/earlier exit have helped?" with data, not vibes:
 *   - BE@+0.5R / BE@+0.75R : move stop to entry once that favorable level is reached.
 *   - EMA-cross reversal exits on several timeframe/period combos, INCLUDING the live
 *     guardian's 15m·50/200 and the proposed 5m checks, exiting at the flip bar's close.
 *
 * The whole-book total (incl. winners) is the honest judge: a "faster" reversal rule that
 * only avoids losers by also scratching the runners that carry the edge will show up there.
 *
 * Read-only: hits the public mainnet klines endpoint, reads live.sqlite, writes nothing.
 *   npm run autopsy            (via: npx tsx src/scripts/autopsy.ts)
 */

interface Trade {
  symbol: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  rDist: number; // price distance of 1R
  openedAt: number;
  closedAt: number;
  closeReason: string;
  rRealized: number;
}

const FEE_R = 0.04; // ~round-trip taker+slippage in R for a typical tight stop (rough)

// Reversal-exit signals to evaluate: [label, timeframe, fastEMA, slowEMA].
const SIGNALS: Array<[string, string, number, number]> = [
  ["15m·50/200", "15m", 50, 200], // the LIVE guardian signal
  ["5m·50/200", "5m", 50, 200], // proposed: same signal type, faster TF
  ["5m·21/50", "5m", 21, 50], // proposed: middle-ground faster signal
  ["15m·9/21", "15m", 9, 21], // hair-trigger fast signal (for reference)
];

function loadTrades(): Trade[] {
  const db = new Database("./data/live.sqlite", { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT symbol, side, entry_price, stop_price, tp1, tp2, qty, risk_usdt, opened_at, closed_at, close_reason, r_realized
       FROM trades WHERE status='CLOSED' AND qty > 0 AND risk_usdt > 0 ORDER BY opened_at`,
    )
    .all() as Array<Record<string, number | string>>;
  db.close();
  return rows.map((r) => ({
    symbol: r.symbol as string,
    side: r.side as Trade["side"],
    entry: r.entry_price as number,
    stop: r.stop_price as number,
    tp1: r.tp1 as number,
    tp2: r.tp2 as number,
    rDist: (r.risk_usdt as number) / (r.qty as number),
    openedAt: r.opened_at as number,
    closedAt: r.closed_at as number,
    closeReason: (r.close_reason as string) ?? "?",
    rRealized: (r.r_realized as number) ?? 0,
  }));
}

const sgnOf = (side: Trade["side"]) => (side === "long" ? 1 : -1);
const favR = (t: Trade, price: number) => (sgnOf(t.side) * (price - t.entry)) / t.rDist;
const favExtreme = (t: Trade, c: Candle) => (t.side === "long" ? c.high : c.low);
const advExtreme = (t: Trade, c: Candle) => (t.side === "long" ? c.low : c.high);

/** Simulate "move stop to breakeven once favorable level `thr`R is reached".
 *  Conservative: arming and BE-exit cannot happen in the SAME bar (no intra-bar lookahead). */
function simBreakeven(t: Trade, path: Candle[], thr: number): number {
  let armed = false;
  for (const c of path) {
    const adv = advExtreme(t, c);
    const fav = favExtreme(t, c);
    const stopHit = t.side === "long" ? adv <= t.stop : adv >= t.stop;
    if (armed) {
      const beHit = t.side === "long" ? adv <= t.entry : adv >= t.entry;
      if (beHit) return -FEE_R; // ~0R minus costs
    } else if (stopHit) {
      return t.rRealized; // never armed before the stop → actual outcome
    }
    if (!armed && favR(t, fav) >= thr) armed = true;
  }
  return t.rRealized;
}

/** Exit at the close of the first bar (>= entry, <= close) where fastEMA crosses AGAINST
 *  the position. `bars` = minutes from entry to that exit (null = never flipped in the window). */
function emaCrossExit(t: Trade, candles: Candle[], fastP: number, slowP: number): { r: number; bars: number | null } {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, fastP);
  const slow = ema(closes, slowP);
  const long = t.side === "long";
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (c.closeTime < t.openedAt) continue;
    if (c.openTime > t.closedAt) break;
    const f = fast[i];
    const s = slow[i];
    if (f === undefined || s === undefined || Number.isNaN(f) || Number.isNaN(s)) continue;
    if (long ? f < s : f > s) {
      const exitR = favR(t, c.close);
      const minsToExit = Math.round((c.closeTime - t.openedAt) / 60_000);
      // Can't beat the actual stop if the flip only confirmed AFTER the stop already fired.
      return { r: Math.max(exitR - FEE_R, t.rRealized), bars: minsToExit };
    }
  }
  return { r: t.rRealized, bars: null };
}

interface Autopsy {
  t: Trade;
  mfeR: number;
  maeR: number;
  barsToMfe: number; // minutes to MFE
  reached: { half: boolean; threeQ: boolean; tp1: boolean };
  be50: number;
  be75: number;
  rev: Map<string, { r: number; bars: number | null }>; // keyed by signal label
}

async function autopsyTrade(t: Trade): Promise<Autopsy> {
  const bufferMs = 60 * 60_000;
  // 5m with ~24h warmup (EMA200 on 5m ≈ 16.7h) so the 5m·50/200 signal is defined at entry.
  const all5m = await getKlines(t.symbol, "5m", {
    startTime: t.openedAt - 24 * 60 * 60_000,
    endTime: t.closedAt + bufferMs,
  });
  // 15m with ~70h warmup (EMA200 on 15m = 50h) so the live 15m·50/200 signal is defined at entry.
  const all15m = await getKlines(t.symbol, "15m", {
    startTime: t.openedAt - 70 * 60 * 60_000,
    endTime: t.closedAt + bufferMs,
  });

  // MFE/MAE measured on the 5m bars at/after entry up to the close.
  const live = all5m.filter((c) => c.closeTime >= t.openedAt && c.openTime <= t.closedAt);
  let mfeR = -Infinity;
  let maeR = Infinity;
  let barsToMfe = 0;
  live.forEach((c, i) => {
    const f = favR(t, favExtreme(t, c));
    const a = favR(t, advExtreme(t, c));
    if (f > mfeR) {
      mfeR = f;
      barsToMfe = (i + 1) * 5;
    }
    if (a < maeR) maeR = a;
  });

  const rev = new Map<string, { r: number; bars: number | null }>();
  for (const [label, tf, fastP, slowP] of SIGNALS) {
    const series = tf === "5m" ? all5m : all15m;
    rev.set(label, emaCrossExit(t, series, fastP, slowP));
  }

  return {
    t,
    mfeR: Number.isFinite(mfeR) ? mfeR : 0,
    maeR: Number.isFinite(maeR) ? maeR : 0,
    barsToMfe,
    reached: { half: mfeR >= 0.5, threeQ: mfeR >= 0.75, tp1: mfeR >= 1.0 },
    be50: simBreakeven(t, live, 0.5),
    be75: simBreakeven(t, live, 0.75),
    rev,
  };
}

const fmtR = (n: number) => (n >= 0 ? "+" : "") + n.toFixed(2);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

async function main(): Promise<void> {
  await binance.syncTime();
  const trades = loadTrades();
  const results: Autopsy[] = [];
  for (const t of trades) {
    try {
      results.push(await autopsyTrade(t));
    } catch (err) {
      console.error(`autopsy ${t.symbol} failed:`, (err as Error).message);
    }
  }
  const stops = results.filter((r) => r.t.closeReason === "STOP");

  // ── Per-stop detail: how far did price run our way, and when did each signal fire? ──
  console.log(`\n=== STOP-LOSS AUTOPSY (${stops.length} full −1R stops, 5m reconstruction) ===\n`);
  console.log("symbol         side   MFE   reached │ actual  15m50/200   5m50/200    5m21/50   15m9/21");
  console.log("─".repeat(98));
  for (const r of stops) {
    const reach = `${r.reached.half ? "½" : "·"}${r.reached.threeQ ? "¾" : "·"}${r.reached.tp1 ? "1" : "·"}`;
    const cell = (label: string) => {
      const v = r.rev.get(label)!;
      const when = v.bars === null ? "—" : `${v.bars}m`;
      return `${fmtR(v.r)}(${when})`.padStart(11);
    };
    console.log(
      `${r.t.symbol.padEnd(13)} ${r.t.side.padEnd(5)} ${fmtR(r.mfeR).padStart(5)} ${reach.padEnd(5)} │ ${fmtR(r.t.rRealized).padStart(6)} ${cell("15m·50/200")} ${cell("5m·50/200")} ${cell("5m·21/50")} ${cell("15m·9/21")}`,
    );
  }

  // ── The verdict tables: total R over the stops, AND over the whole book (incl. winners). ──
  const tot = (group: Autopsy[], pick: (r: Autopsy) => number) => fmtR(sum(group.map(pick)));
  console.log("\n=== TOTAL R — does the rule help? ===");
  console.log("                       stops(10)   whole book(33)   ← winners preserved?");
  console.log(`actual                  ${tot(stops, (r) => r.t.rRealized).padStart(7)}      ${tot(results, (r) => r.t.rRealized).padStart(7)}`);
  console.log(`BE @ +0.5R              ${tot(stops, (r) => r.be50).padStart(7)}      ${tot(results, (r) => r.be50).padStart(7)}`);
  console.log(`BE @ +0.75R             ${tot(stops, (r) => r.be75).padStart(7)}      ${tot(results, (r) => r.be75).padStart(7)}`);
  for (const [label] of SIGNALS) {
    console.log(
      `reversal ${label.padEnd(13)}  ${tot(stops, (r) => r.rev.get(label)!.r).padStart(7)}      ${tot(results, (r) => r.rev.get(label)!.r).padStart(7)}`,
    );
  }

  const n = stops.length;
  if (n) {
    const reachedHalf = stops.filter((r) => r.reached.half).length;
    const reached1 = stops.filter((r) => r.reached.tp1).length;
    console.log(
      `\nOf the ${n} −1R stops:  ≥+0.5R first: ${reachedHalf}/${n}   ≥+1R (TP1): ${reached1}/${n}   avg MFE ${fmtR(sum(stops.map((r) => r.mfeR)) / n)}R`,
    );
    // How often does each reversal signal fire AT/RIGHT AFTER entry (≤15m)? (degeneracy check)
    console.log("\nReversal signals firing within 15m of entry (degeneracy check — would scratch the entry pullback itself):");
    for (const [label] of SIGNALS) {
      const fast = results.filter((r) => {
        const b = r.rev.get(label)!.bars;
        return b !== null && b <= 15;
      }).length;
      console.log(`  ${label.padEnd(13)} fires ≤15m on ${fast}/${results.length} of ALL trades`);
    }
  }
}

main().catch((err) => {
  console.error("autopsy failed:", err);
  process.exit(1);
});
