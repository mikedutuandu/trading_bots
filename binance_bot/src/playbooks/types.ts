import type { Candle, Signal } from "../types.js";

/**
 * Indicator arrays precomputed once per symbol, aligned to the candle array.
 * Playbooks read values at index `i` (using only data ≤ i — no lookahead).
 */
export interface IndicatorCtx {
  ema20: number[];
  ema50: number[];
  ema200: number[];
  atr14: number[];
  rsi14: number[];
  adx14: number[];
  donchUpper: number[];
  donchLower: number[];
}

/** Tunable strategy parameters (defaults live in config/strategy params). */
export interface StrategyParams {
  atrStopMult: number; // k in stop = entry ∓ k*ATR
  adxMin: number; // trend-strength gate (0 disables)
  rMultiples: [number, number, number]; // TP1/TP2 in R; 3rd is a reference target (runner trails)
  donchianPeriod: number;
  maxHoldBars: number; // 0 disables; else time-stop a pre-TP1 trade (never reached +1R) after N bars
  stallBars: number; // 0 disables; else close a TP1-hit trade that hasn't reached TP2 within N bars (frees the slot)
  maxTotalBars: number; // 0 disables; else hard cap on ANY trade's age in bars (closes runners too — usually hurts)
  trailMult: number; // ATR multiple for the chandelier trailing stop on the runner
  takeFrac1: number; // fraction of position taken at TP1 (rest rides)
  takeFrac2: number; // fraction taken at TP2 (remainder trails)
  cooldownBars: number; // bars to wait per-symbol after a close before re-entering
  ema200SlopeLookback: number; // 0 disables; else require EMA200 sloping with the trade
}

export const DEFAULT_PARAMS: StrategyParams = {
  atrStopMult: 1.5,
  adxMin: 20,
  rMultiples: [1, 2, 3],
  donchianPeriod: 20,
  maxHoldBars: 72,
  stallBars: 0,
  maxTotalBars: 0,
  trailMult: 3,
  takeFrac1: 1 / 3,
  takeFrac2: 1 / 3,
  cooldownBars: 0,
  ema200SlopeLookback: 0,
};

export interface Playbook {
  name: string;
  /** Evaluate at bar `i`; return a Signal to enter, or null. */
  detect(
    candles: Candle[],
    i: number,
    ind: IndicatorCtx,
    params: StrategyParams,
  ): Signal | null;
}

/** Build a Signal with TP ladder derived from R = |entry - stop|. */
export function makeSignal(
  base: Omit<Signal, "tp1" | "tp2" | "tp3">,
  params: StrategyParams,
): Signal | null {
  const r = Math.abs(base.entry - base.stop);
  if (r <= 0) return null;
  const sign = base.side === "long" ? 1 : -1;
  const [m1, m2, m3] = params.rMultiples;
  return {
    ...base,
    tp1: base.entry + sign * m1 * r,
    tp2: base.entry + sign * m2 * r,
    tp3: base.entry + sign * m3 * r,
  };
}
