/**
 * Shared guardian semantics — the ONE definition used by BOTH the live monitor
 * (engine/loop.ts monitorOpenPositions) and the backtest's LIVE_SIM replay
 * (backtest/runner.ts). Keeping the predicate + warmup here means a future tweak
 * to the flip condition cannot drift between live and simulation.
 */

/** Bars required before EMA200 is trusted (warmup gate, all timeframes). */
export const EMA_WARMUP_BARS = 250;

/** The guardian's trend verdict for one bar of the faster timeframe. */
export const fasterTfUp = (ema50: number, ema200: number): boolean => ema50 > ema200;

/** Is that verdict AGAINST the position? (long is against in a downtrend, short in an uptrend) */
export const againstPosition = (uptrend: boolean, long: boolean): boolean => (long ? !uptrend : uptrend);
