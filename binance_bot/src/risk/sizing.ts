import type { Signal, SymbolFilter } from "../types.js";

/** Round quantity DOWN to the exchange step size (never over-risk). */
export function roundToStep(qty: number, step: number): number {
  if (step <= 0) return qty;
  const rounded = Math.floor(qty / step) * step;
  // Strip float dust (e.g. 9*0.0001 → 0.0009000000000000001) or Binance rejects
  // the quantity with -1111 "Precision is over the maximum".
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)));
  return Number(rounded.toFixed(decimals));
}

/** Round price to the nearest tick. */
export function roundToTick(price: number, tick: number): number {
  if (tick <= 0) return price;
  const rounded = Math.round(price / tick) * tick;
  // Avoid float dust by fixing to the tick's decimal places.
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number(rounded.toFixed(decimals));
}

/**
 * Split a (step-rounded) total position into TP1/TP2 tranches, each rounded to the
 * exchange step size, with the trailing runner taking the residual
 * (qtyTotal − qtyTp1 − qtyTp2). Rounding here — rather than sending a raw fraction —
 * keeps live reduceOnly orders off the -1111/-2010 precision rejects AND keeps the
 * backtest/paper tranche sizes identical to what live actually executes. SHARED by
 * the backtest (runner.ts) and the live engine (loop.ts) so they can't drift.
 *
 * A tranche that rounds below one step → 0; the `qtyTp1 > 0` / `qtyTp2 > 0` guards in
 * manageOnCandle then skip that partial instead of sending a 0-qty order (which
 * placeMarketOrder rejects). So a position too small to split just rides to the trail.
 */
export function splitTranches(
  qtyTotal: number,
  takeFrac1: number,
  takeFrac2: number,
  stepSize: number,
): { qtyTp1: number; qtyTp2: number } {
  // Round each tranche DOWN to step; clamp so qtyTp1 + qtyTp2 can NEVER exceed
  // qtyTotal → the trailing runner residual (qtyTotal − qtyTp1 − qtyTp2) is always
  // ≥ 0, even if the configured fractions are nonsensical (e.g. sum > 1 or > 1 each).
  // This bounds what manageOnCandle subtracts from qtyRemaining, so it can't go
  // negative. A tranche below one step → 0; the `qtyTp1 > 0` / `qtyTp2 > 0` guards in
  // manageOnCandle then skip that partial instead of sending a 0-qty order (which
  // placeMarketOrder rejects). (Identical output to a raw split for any valid
  // fractions summing ≤ 1; the clamps only bite on misconfiguration.)
  const qtyTp1 = Math.min(qtyTotal, Math.max(0, roundToStep(qtyTotal * takeFrac1, stepSize)));
  const remainder = Math.max(0, roundToStep(qtyTotal - qtyTp1, stepSize));
  const qtyTp2 = Math.min(remainder, Math.max(0, roundToStep(qtyTotal * takeFrac2, stepSize)));
  return { qtyTp1, qtyTp2 };
}

export interface SizedPosition {
  qty: number;
  notional: number;
  margin: number;
  riskUsdt: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
}

/** Optional sizing overrides/caps — used for the real-money phase (M8). */
export interface SizingOpts {
  riskUsdt?: number; // fixed USDT risk per trade; overrides equity*riskPct when > 0
  maxRiskUsdt?: number; // hard ceiling on risk per trade (0 = none)
  maxNotional?: number; // hard ceiling on notional per trade (0 = none)
}

/**
 * Size a position so that hitting the stop loses exactly the target risk
 * (`riskUsdt` if given, else `riskPct` of equity). Notional is DERIVED from the
 * stop distance — risk is fixed, size varies. Caps shrink the size further (never
 * up). Returns null if the trade can't meet exchange minimums.
 */
export function sizePosition(
  signal: Signal,
  equity: number,
  riskPct: number,
  leverage: number,
  filter: SymbolFilter,
  opts: SizingOpts = {},
): SizedPosition | null {
  const stopDist = Math.abs(signal.entry - signal.stop);
  if (stopDist <= 0) return null;

  let targetRisk = opts.riskUsdt && opts.riskUsdt > 0 ? opts.riskUsdt : equity * riskPct;
  if (opts.maxRiskUsdt && opts.maxRiskUsdt > 0) targetRisk = Math.min(targetRisk, opts.maxRiskUsdt);

  const entry = roundToTick(signal.entry, filter.tickSize);
  let qty = roundToStep(targetRisk / stopDist, filter.stepSize);

  // Cap notional (shrink qty so notional ≤ maxNotional). Reduces risk below target.
  if (opts.maxNotional && opts.maxNotional > 0 && qty * entry > opts.maxNotional) {
    qty = roundToStep(opts.maxNotional / entry, filter.stepSize);
  }
  if (qty <= 0 || qty < filter.minQty) return null;

  const notional = qty * entry;
  if (notional < filter.minNotional) return null;

  return {
    qty,
    notional,
    margin: notional / leverage,
    // Recompute risk from the rounded qty/stop for honest accounting.
    riskUsdt: qty * stopDist,
    entry,
    stop: roundToTick(signal.stop, filter.tickSize),
    tp1: roundToTick(signal.tp1, filter.tickSize),
    tp2: roundToTick(signal.tp2, filter.tickSize),
    tp3: roundToTick(signal.tp3, filter.tickSize),
  };
}
