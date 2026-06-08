/**
 * Shared cross-sectional long/short signal logic — used VERBATIM by the backtest
 * (backtest-xsmom.ts), the paper tracker (xsmom-paper.ts), and the live executor
 * (xsmom-exec.ts), so the strategy can't drift between research and real money
 * (the repo's "build the strategy logic once, reuse for backtest/live" rule).
 */

export type XsSignal = "momentum" | "reversal" | "funding" | "combo";

export const XS_SIGNALS: XsSignal[] = ["momentum", "reversal", "funding", "combo"];

export interface Candidate {
  symbol: string;
  priceMom: number; // trailing return over the lookback: close[t]/close[t-L] - 1
  avgFund: number; // mean funding rate over the lookback window
}

/** Mean of a rate series (0 if empty). */
export function avgRate(rates: number[]): number {
  return rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : 0;
}

/** Funding PnL contribution of a signed-weight position for ONE 8h settlement.
 *  Long (+weight) PAYS when rate>0; short (−weight) RECEIVES. */
export function fundingPnl(signedWeight: number, rate: number): number {
  return -signedWeight * rate;
}

function zscores(xs: number[]): number[] {
  if (xs.length === 0) return [];
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const s = Math.sqrt(Math.max(1e-12, xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length));
  return xs.map((x) => (x - m) / s);
}

/** Score each candidate so HIGHER score = stronger LONG, per the chosen signal. */
export function scoreCandidates(signal: XsSignal, cands: Candidate[]): Array<{ symbol: string; score: number }> {
  switch (signal) {
    case "momentum":
      return cands.map((c) => ({ symbol: c.symbol, score: c.priceMom }));
    case "reversal":
      return cands.map((c) => ({ symbol: c.symbol, score: -c.priceMom }));
    case "funding":
      return cands.map((c) => ({ symbol: c.symbol, score: -c.avgFund })); // long lowest funding, short highest
    case "combo": {
      const zp = zscores(cands.map((c) => c.priceMom));
      const zf = zscores(cands.map((c) => c.avgFund));
      return cands.map((c, i) => ({ symbol: c.symbol, score: -zp[i]! - zf[i]! }));
    }
  }
}

/** Rank by score (desc) and split: LONG the top-K, SHORT the bottom-K.
 *  Returns null when fewer than 2K candidates (can't form a balanced book). */
export function pickLongShort(
  scored: Array<{ symbol: string; score: number }>,
  k: number,
): { longs: string[]; shorts: string[] } | null {
  if (scored.length < 2 * k) return null;
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  return { longs: sorted.slice(0, k).map((s) => s.symbol), shorts: sorted.slice(-k).map((s) => s.symbol) };
}
