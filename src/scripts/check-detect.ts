/**
 * Deterministic checks for the ENTRY engine (trendPullback.detect) — the signal function
 * shared by BOTH the backtest and the live engine. Proves each gate in isolation by
 * constructing the candle + indicator context directly:
 *   trend gate (EMA50 vs EMA200) · wick-reclaim of EMA20 · candle color · ADX gate ·
 *   EMA200-slope gate · warmup/NaN safety · stop/TP geometry off the signal.
 *
 * No test runner in this repo — run directly:  npx tsx src/scripts/check-detect.ts
 */
import { trendPullback } from "../playbooks/trendPullback.js";
import { DEFAULT_PARAMS, type IndicatorCtx, type StrategyParams } from "../playbooks/types.js";
import type { Candle } from "../types.js";

let failures = 0;
function ok(cond: boolean, label: string, detail = ""): void {
  console.log(`${cond ? "  ✓" : "  ✗ FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
  if (!cond) failures++;
}
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;

// One evaluated bar at index I; index 0 exists only so slope lookback has a past value.
const I = 1;

const candle = (open: number, high: number, low: number, close: number): Candle => ({
  symbol: "T", interval: "1h", openTime: I * 3_600_000, open, high, low, close, volume: 0, closeTime: I * 3_600_000 + 3_599_999,
});

/** Indicator context where index I carries the scenario and index 0 the slope past. */
function ind(over: Partial<Record<keyof IndicatorCtx, number>>, ema200Past = NaN): IndicatorCtx {
  const at = (v: number): number[] => {
    const a = new Array<number>(I + 1).fill(NaN);
    a[I] = v;
    return a;
  };
  const ctx: IndicatorCtx = {
    ema20: at(over.ema20 ?? NaN),
    ema50: at(over.ema50 ?? NaN),
    ema200: at(over.ema200 ?? NaN),
    atr14: at(over.atr14 ?? NaN),
    rsi14: at(over.rsi14 ?? 50),
    adx14: at(over.adx14 ?? NaN),
    donchUpper: at(over.donchUpper ?? NaN),
    donchLower: at(over.donchLower ?? NaN),
  };
  ctx.ema200[0] = ema200Past;
  return ctx;
}

const P: StrategyParams = { ...DEFAULT_PARAMS, atrStopMult: 1.5, adxMin: 35, ema200SlopeLookback: 0 };
const candles: Candle[] = [candle(100, 100, 100, 100), candle(0, 0, 0, 0)]; // [I] replaced per case

function detect(c: Candle, ix: IndicatorCtx, params: StrategyParams = P) {
  candles[I] = c;
  return trendPullback.detect(candles, I, ix, params);
}

// ── LONG: uptrend (50>200), wick dips to EMA20, green close back above ──
{
  const up = ind({ ema20: 100, ema50: 105, ema200: 95, atr14: 2, adx14: 40 });
  const sig = detect(candle(99.5, 102, 99, 101), up);
  ok(sig?.side === "long", "uptrend pullback reclaim → LONG");
  ok(!!sig && near(sig.stop, 101 - 1.5 * 2), "LONG stop = entry − 1.5×ATR", `stop=${sig?.stop}`);
  ok(!!sig && near(sig.tp1, 101 + (101 - sig.stop)) && near(sig.tp2, 101 + 2 * (101 - sig.stop)), "TP1/TP2 = +1R/+2R");
  ok(detect(candle(102, 102.5, 99, 101), up) === null, "RED candle (close<open) → no LONG");
  ok(detect(candle(100.5, 102, 100.2, 101), up) === null, "no wick to EMA20 (low>ema20) → null");
  ok(detect(candle(99.5, 102, 99, 99.8), up) === null, "close back BELOW ema20 → null");
}

// ── SHORT mirror: downtrend, wick pokes EMA20 from below, red close back under ──
{
  const dn = ind({ ema20: 100, ema50: 95, ema200: 105, atr14: 2, adx14: 40 });
  const sig = detect(candle(100.5, 101, 98, 99), dn);
  ok(sig?.side === "short", "downtrend pullback rejection → SHORT");
  ok(!!sig && near(sig.stop, 99 + 1.5 * 2), "SHORT stop = entry + 1.5×ATR", `stop=${sig?.stop}`);
  ok(detect(candle(98.5, 101, 98, 99), dn) === null, "GREEN candle → no SHORT");
}

// ── Gates ──
{
  const upLowAdx = ind({ ema20: 100, ema50: 105, ema200: 95, atr14: 2, adx14: 34.9 });
  ok(detect(candle(99.5, 102, 99, 101), upLowAdx) === null, "ADX 34.9 < gate 35 → null");
  const upAtGate = ind({ ema20: 100, ema50: 105, ema200: 95, atr14: 2, adx14: 35 });
  ok(detect(candle(99.5, 102, 99, 101), upAtGate)?.side === "long", "ADX exactly 35 passes (>=)");
  const noTrend = ind({ ema20: 100, ema50: 95, ema200: 105, atr14: 2, adx14: 40 });
  ok(detect(candle(99.5, 102, 99, 101), noTrend) === null, "EMA50<EMA200 → no LONG in downtrend");
}

// ── EMA200-slope gate ──
{
  const slopeP: StrategyParams = { ...P, ema200SlopeLookback: 1 };
  const upSloping = ind({ ema20: 100, ema50: 105, ema200: 95, atr14: 2, adx14: 40 }, 94); // 200ema rising
  ok(detect(candle(99.5, 102, 99, 101), upSloping, slopeP)?.side === "long", "slope gate: rising EMA200 → LONG ok");
  const upFlatDown = ind({ ema20: 100, ema50: 105, ema200: 95, atr14: 2, adx14: 40 }, 96); // 200ema falling
  ok(detect(candle(99.5, 102, 99, 101), upFlatDown, slopeP) === null, "slope gate: falling EMA200 blocks LONG");
  ok(detect(candle(99.5, 102, 99, 101), upFlatDown, P)?.side === "long", "slope gate OFF (lookback=0) ignores falling EMA200");
}

// ── Warmup / NaN safety ──
{
  ok(detect(candle(99.5, 102, 99, 101), ind({ ema50: 105, ema200: 95, atr14: 2, adx14: 40 })) === null, "NaN ema20 → null");
  ok(detect(candle(99.5, 102, 99, 101), ind({ ema20: 100, ema50: 105, ema200: 95, adx14: 40 })) === null, "NaN ATR → null");
  ok(detect(candle(99.5, 102, 99, 101), ind({ ema20: 100, ema50: 105, ema200: 95, atr14: 0, adx14: 40 })) === null, "ATR=0 → null (no zero-width stop)");
  ok(detect(candle(99.5, 102, 99, 101), ind({ ema20: 100, ema50: 105, ema200: 95, atr14: 2 })) === null, "NaN ADX with gate on → null");
}

console.log(failures === 0 ? "\nALL PASS ✓" : `\n${failures} FAILURE(S) ✗`);
process.exit(failures === 0 ? 0 : 1);
