import type { Candle } from "../types.js";

/**
 * Pure technical-analysis functions. Each returns an array aligned to the input
 * length, with `NaN` for leading positions where the indicator isn't defined yet.
 * No lookahead: value at index i uses only candles 0..i.
 */

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values.
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function trueRanges(candles: Candle[]): number[] {
  const tr = new Array<number>(candles.length).fill(NaN);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i === 0) {
      tr[i] = c.high - c.low;
      continue;
    }
    const prevClose = candles[i - 1]!.close;
    tr[i] = Math.max(
      c.high - c.low,
      Math.abs(c.high - prevClose),
      Math.abs(c.low - prevClose),
    );
  }
  return tr;
}

/** Wilder-smoothed Average True Range. */
export function atr(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  const tr = trueRanges(candles);
  if (candles.length <= period) return out;
  // Seed with simple average of first `period` true ranges.
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. */
export function rsi(candles: Candle[], period: number): number[] {
  const out = new Array<number>(candles.length).fill(NaN);
  if (candles.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFrom(avgGain, avgLoss);
  for (let i = period + 1; i < candles.length; i++) {
    const diff = candles[i]!.close - candles[i - 1]!.close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFrom(avgGain, avgLoss);
  }
  return out;
}

function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder's ADX (trend strength). Returns array aligned to candles. */
export function adx(candles: Candle[], period: number): number[] {
  const n = candles.length;
  const out = new Array<number>(n).fill(NaN);
  if (n <= 2 * period) return out;

  const plusDM = new Array<number>(n).fill(0);
  const minusDM = new Array<number>(n).fill(0);
  const tr = trueRanges(candles);

  for (let i = 1; i < n; i++) {
    const up = candles[i]!.high - candles[i - 1]!.high;
    const down = candles[i - 1]!.low - candles[i]!.low;
    plusDM[i] = up > down && up > 0 ? up : 0;
    minusDM[i] = down > up && down > 0 ? down : 0;
  }

  // Wilder smoothing of TR, +DM, -DM over `period`.
  let trS = 0;
  let plusS = 0;
  let minusS = 0;
  for (let i = 1; i <= period; i++) {
    trS += tr[i]!;
    plusS += plusDM[i]!;
    minusS += minusDM[i]!;
  }

  const dx = new Array<number>(n).fill(NaN);
  for (let i = period + 1; i < n; i++) {
    trS = trS - trS / period + tr[i]!;
    plusS = plusS - plusS / period + plusDM[i]!;
    minusS = minusS - minusS / period + minusDM[i]!;
    const plusDI = trS === 0 ? 0 : (100 * plusS) / trS;
    const minusDI = trS === 0 ? 0 : (100 * minusS) / trS;
    const denom = plusDI + minusDI;
    dx[i] = denom === 0 ? 0 : (100 * Math.abs(plusDI - minusDI)) / denom;
  }

  // ADX = Wilder average of DX.
  const firstDx = period + 1;
  const adxStart = firstDx + period - 1;
  if (adxStart >= n) return out;
  let sum = 0;
  for (let i = firstDx; i < firstDx + period; i++) sum += dx[i]!;
  let prev = sum / period;
  out[adxStart] = prev;
  for (let i = adxStart + 1; i < n; i++) {
    prev = (prev * (period - 1) + dx[i]!) / period;
    out[i] = prev;
  }
  return out;
}

/** Donchian channel: rolling highest-high / lowest-low over `period` (exclusive of current bar). */
export function donchian(
  candles: Candle[],
  period: number,
): { upper: number[]; lower: number[] } {
  const n = candles.length;
  const upper = new Array<number>(n).fill(NaN);
  const lower = new Array<number>(n).fill(NaN);
  for (let i = period; i < n; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - period; j < i; j++) {
      hi = Math.max(hi, candles[j]!.high);
      lo = Math.min(lo, candles[j]!.low);
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper, lower };
}

/** Is index i a swing high? (higher than `lookback` bars on each side.) */
export function isSwingHigh(candles: Candle[], i: number, lookback: number): boolean {
  if (i < lookback || i + lookback >= candles.length) return false;
  const h = candles[i]!.high;
  for (let j = i - lookback; j <= i + lookback; j++) {
    if (j !== i && candles[j]!.high >= h) return false;
  }
  return true;
}

export function isSwingLow(candles: Candle[], i: number, lookback: number): boolean {
  if (i < lookback || i + lookback >= candles.length) return false;
  const l = candles[i]!.low;
  for (let j = i - lookback; j <= i + lookback; j++) {
    if (j !== i && candles[j]!.low <= l) return false;
  }
  return true;
}

/** Most recent confirmed swing low at or before index `i` (price level), or null. */
export function lastSwingLow(candles: Candle[], i: number, lookback: number): number | null {
  for (let j = i - lookback; j >= lookback; j--) {
    if (isSwingLow(candles, j, lookback)) return candles[j]!.low;
  }
  return null;
}

export function lastSwingHigh(candles: Candle[], i: number, lookback: number): number | null {
  for (let j = i - lookback; j >= lookback; j--) {
    if (isSwingHigh(candles, j, lookback)) return candles[j]!.high;
  }
  return null;
}
