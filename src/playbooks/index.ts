import type { Candle } from "../types.js";
import { atr, adx, donchian, ema, rsi } from "../indicators/ta.js";
import { trendPullback } from "./trendPullback.js";
import { trendBreakout } from "./trendBreakout.js";
import { meanReversion } from "./meanReversion.js";
import type { IndicatorCtx, Playbook } from "./types.js";

export const ALL_PLAYBOOKS: Record<string, Playbook> = {
  "trend-pullback": trendPullback,
  "trend-breakout": trendBreakout,
  "mean-reversion": meanReversion, // RESEARCH / experimental — opt-in via PLAYBOOKS=mean-reversion
};

/** Resolve playbooks by name (comma list), defaulting to trend-pullback only. */
export function resolvePlaybooks(names?: string): Playbook[] {
  const wanted = (names ?? "trend-pullback")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return wanted.map((n) => {
    const pb = ALL_PLAYBOOKS[n];
    if (!pb) throw new Error(`Unknown playbook: ${n}. Known: ${Object.keys(ALL_PLAYBOOKS).join(", ")}`);
    return pb;
  });
}

/** Precompute all indicator arrays for a symbol's candle series. */
export function computeIndicators(candles: Candle[], donchianPeriod: number): IndicatorCtx {
  const closes = candles.map((c) => c.close);
  const d = donchian(candles, donchianPeriod);
  return {
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    atr14: atr(candles, 14),
    rsi14: rsi(candles, 14),
    adx14: adx(candles, 14),
    donchUpper: d.upper,
    donchLower: d.lower,
  };
}
