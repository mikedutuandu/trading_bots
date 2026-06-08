import { config } from "../config.js";
import { logger } from "../logger.js";
import { getDb, closeDb } from "../storage/db.js";
import { getCandles } from "../storage/candles.js";
import { getFundingRates } from "../storage/funding.js";
import { type Candidate, type XsSignal, avgRate, fundingPnl, pickLongShort, scoreCandidates } from "../signals/crossSectional.js";

/**
 * Cross-sectional long/short backtest harness — ranks ALL symbols each rebalance,
 * goes LONG the top-K / SHORT the bottom-K by a chosen SIGNAL (equal weight, ~dollar
 * neutral), holds H bars. Fees on actual turnover; FUNDING modelled per 8h settlement
 * (long pays when rate>0, short receives). Walk-forward TRAIN vs OOS.
 *
 * SIGNAL (env):
 *   momentum  — long recent winners, short recent losers (score = trailing return)
 *   reversal  — long recent losers, short recent winners (score = -trailing return)
 *   funding   — long lowest-funding, short highest-funding (harvest the funding premium)
 *   combo     — long dumped+negative-funding, short pumped+high-funding (z(-ret)+z(-fund))
 *
 *   SIGNAL=funding TRAIN_END=2025-12-01 XSMOM_SYMBOLS=BTCUSDT,... tsx src/scripts/backtest-xsmom.ts
 */

const TF = config.strategy.timeframe;
const COST = config.risk.takerFee + config.risk.slippageBps / 10_000;
const SIGNAL = (process.env.SIGNAL ?? "momentum") as XsSignal;

interface Combo {
  lookback: number;
  hold: number;
  k: number;
}

const GRID: Combo[] = [];
for (const lookback of [6, 12, 24, 48, 96, 168])
  for (const hold of [8, 24, 48])
    for (const k of [3, 5]) GRID.push({ lookback, hold, k });

interface Series {
  symbol: string;
  closeAt: Map<number, number>;
}

function loadSeries(symbols: string[]): { series: Series[]; times: number[] } {
  const series: Series[] = [];
  const timeSet = new Set<number>();
  for (const symbol of symbols) {
    const candles = getCandles(symbol, TF);
    if (candles.length === 0) continue;
    const closeAt = new Map<number, number>();
    for (const c of candles) {
      closeAt.set(c.openTime, c.close);
      timeSet.add(c.openTime);
    }
    series.push({ symbol, closeAt });
  }
  return { series, times: [...timeSet].sort((a, b) => a - b) };
}

function loadFunding(symbols: string[]): { fundMap: Map<string, Map<number, number>>; fundTimes: number[] } {
  const fundMap = new Map<string, Map<number, number>>();
  const timeSet = new Set<number>();
  for (const symbol of symbols) {
    const { times, rates } = getFundingRates(symbol);
    if (times.length === 0) continue;
    const m = new Map<number, number>();
    for (let i = 0; i < times.length; i++) {
      m.set(times[i]!, rates[i]!);
      timeSet.add(times[i]!);
    }
    fundMap.set(symbol, m);
  }
  return { fundMap, fundTimes: [...timeSet].sort((a, b) => a - b) };
}

/** First index i with arr[i] > x. */
function firstAfter(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

interface PeriodResult {
  time: number;
  ret: number;
  fund: number;
}

function runXS(
  series: Series[],
  times: number[],
  fundMap: Map<string, Map<number, number>>,
  fundTimes: number[],
  combo: Combo,
): PeriodResult[] {
  const { lookback: L, hold: H, k: K } = combo;
  const out: PeriodResult[] = [];
  let prevWeights = new Map<string, number>();
  const w = 1 / (2 * K);

  for (let gi = L; gi + H < times.length; gi += H) {
    const tSig = times[gi]!;
    const tPast = times[gi - L]!;
    const tFwd = times[gi + H]!;

    // Funding settlement indices in the SIGNAL window (tPast, tSig] — for the funding predictor.
    const sLo = firstAfter(fundTimes, tPast);
    let sHi = firstAfter(fundTimes, tSig); // exclusive upper for (tPast, tSig]
    // (sLo..sHi) are settlements with tPast < ft <= tSig

    const elig: Array<Candidate & { fwd: number }> = [];
    for (const s of series) {
      const cPast = s.closeAt.get(tPast);
      const cNow = s.closeAt.get(tSig);
      const cFwd = s.closeAt.get(tFwd);
      if (cPast === undefined || cNow === undefined || cFwd === undefined) continue;
      if (cPast <= 0 || cNow <= 0 || cFwd <= 0) continue;
      const rates: number[] = [];
      const fm = fundMap.get(s.symbol);
      if (fm) for (let i = sLo; i < sHi; i++) { const r = fm.get(fundTimes[i]!); if (r !== undefined) rates.push(r); }
      elig.push({ symbol: s.symbol, priceMom: cNow / cPast - 1, avgFund: avgRate(rates), fwd: cFwd / cNow - 1 });
    }
    const picked = pickLongShort(scoreCandidates(SIGNAL, elig), K);
    if (!picked) {
      prevWeights = new Map();
      continue;
    }
    const fwdBy = new Map(elig.map((e) => [e.symbol, e.fwd]));

    let gross = 0;
    const newWeights = new Map<string, number>();
    for (const sym of picked.longs) {
      gross += w * fwdBy.get(sym)!;
      newWeights.set(sym, w);
    }
    for (const sym of picked.shorts) {
      gross += w * -fwdBy.get(sym)!;
      newWeights.set(sym, -w);
    }

    let turnover = 0;
    const union = new Set<string>([...prevWeights.keys(), ...newWeights.keys()]);
    for (const sym of union) turnover += Math.abs((newWeights.get(sym) ?? 0) - (prevWeights.get(sym) ?? 0));
    const fee = turnover * COST;

    // Funding PnL over the HOLD window (tSig, tFwd]: contribution = -weight * rate.
    let fund = 0;
    for (let fi = firstAfter(fundTimes, tSig); fi < fundTimes.length && fundTimes[fi]! <= tFwd; fi++) {
      const ft = fundTimes[fi]!;
      for (const [sym, weight] of newWeights) {
        const rate = fundMap.get(sym)?.get(ft);
        if (rate !== undefined) fund += fundingPnl(weight, rate);
      }
    }

    out.push({ time: tSig, ret: gross - fee + fund, fund });
    prevWeights = newWeights;
  }
  return out;
}

interface Metrics {
  ret: number;
  sharpe: number;
  maxDD: number;
  win: number;
  n: number;
  fund: number;
}

function metrics(periods: PeriodResult[], hold: number): Metrics {
  if (periods.length === 0) return { ret: 0, sharpe: 0, maxDD: 0, win: 0, n: 0, fund: 0 };
  let eq = 1;
  let peak = 1;
  let maxDD = 0;
  let wins = 0;
  let sum = 0;
  let sumSq = 0;
  let fund = 0;
  for (const p of periods) {
    eq *= 1 + p.ret;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak);
    if (p.ret > 0) wins++;
    sum += p.ret;
    sumSq += p.ret * p.ret;
    fund += p.fund;
  }
  const n = periods.length;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  const sharpe = std > 0 ? (mean / std) * Math.sqrt((365 * 24) / hold) : 0;
  return { ret: eq - 1, sharpe, maxDD, win: wins / n, n, fund };
}

function main(): void {
  getDb();
  const trainEnd = process.env.TRAIN_END ? new Date(process.env.TRAIN_END).getTime() : undefined;
  if (!trainEnd) throw new Error("Set TRAIN_END=YYYY-MM-DD for walk-forward");

  const db = getDb();
  const allowed = process.env.XSMOM_SYMBOLS
    ? new Set(process.env.XSMOM_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean))
    : null;
  const symbols = (
    db.prepare(`SELECT DISTINCT symbol FROM candles WHERE interval = ? ORDER BY symbol`).all(TF) as Array<{ symbol: string }>
  )
    .map((r) => r.symbol)
    .filter((s) => !allowed || allowed.has(s));

  const { series, times } = loadSeries(symbols);
  const { fundMap, fundTimes } = loadFunding(symbols);
  logger.info(`xs[${SIGNAL}]: ${series.length} symbols, ${times.length} bars, cost ${(COST * 100).toFixed(3)}%/turnover`);
  logger.info(`grid: ${GRID.length} combos, train→${process.env.TRAIN_END}`);

  const rows: Array<{ label: string; tr: Metrics; te: Metrics }> = [];
  for (const combo of GRID) {
    const periods = runXS(series, times, fundMap, fundTimes, combo);
    const tr = metrics(periods.filter((p) => p.time <= trainEnd), combo.hold);
    const te = metrics(periods.filter((p) => p.time > trainEnd), combo.hold);
    rows.push({ label: `L${combo.lookback} H${combo.hold} K${combo.k}`, tr, te });
  }
  rows.sort((a, b) => b.tr.ret - a.tr.ret);

  const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
  console.log(`\nSIGNAL=${SIGNAL}  ${"CONFIG".padEnd(14)} │ TRAIN ret/Shrp/DD/fund/n     │ TEST(OOS) ret/Shrp/DD/fund/n`);
  console.log("─".repeat(100));
  for (const r of rows) {
    const both = r.tr.ret > 0 && r.te.ret > 0 ? " ✅both" : "";
    console.log(
      `${r.label.padEnd(22)} │ ${pct(r.tr.ret).padStart(7)} ${r.tr.sharpe.toFixed(2).padStart(5)} ${(r.tr.maxDD * 100).toFixed(0).padStart(3)}% ${pct(r.tr.fund).padStart(6)} ${String(r.tr.n).padStart(4)} │ ` +
        `${pct(r.te.ret).padStart(7)} ${r.te.sharpe.toFixed(2).padStart(5)} ${(r.te.maxDD * 100).toFixed(0).padStart(3)}% ${pct(r.te.fund).padStart(6)} ${String(r.te.n).padStart(4)}${both}`,
    );
  }
  console.log("─".repeat(100));
  console.log(`✅both = positive TRAIN and OOS. 'fund' = funding return for the segment.\n`);
  closeDb();
}

main();
