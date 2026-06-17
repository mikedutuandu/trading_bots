/**
 * Shared guardian semantics — the ONE definition used by BOTH the live monitor
 * (engine/loop.ts monitorOpenPositions) and the backtest's LIVE_SIM replay
 * (backtest/runner.ts). Keeping the predicate + warmup here means a future tweak
 * to the flip condition cannot drift between live and simulation.
 */

/** Bars required before EMA200 is trusted (warmup gate, all timeframes). */
export const EMA_WARMUP_BARS = 250;

/** Candles to FETCH for live indicator computation. EMA200 only converges after ~5× its
 *  period; at 320 candles it's ~30% seed-contaminated, so the ema50>ema200 verdict drifted
 *  from the backtest's full-history EMA on ~3% of bars (live↔backtest divergence). 1000
 *  (≤ Binance's 1500/call cap → one request) → EMA200 converged → live matches the backtest.
 *  Shared by the engine fetch (loop.ts) and the scan diagnostic so they can't drift.
 *  Audit: `tsx src/scripts/audit-warmup.ts`. */
export const EMA_CONVERGE_BARS = 1000;

/** The guardian's trend verdict for one bar of the faster timeframe. */
export const fasterTfUp = (ema50: number, ema200: number): boolean => ema50 > ema200;

/** Is that verdict AGAINST the position? (long is against in a downtrend, short in an uptrend) */
export const againstPosition = (uptrend: boolean, long: boolean): boolean => (long ? !uptrend : uptrend);
