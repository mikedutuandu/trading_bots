import { DEFAULT_PARAMS, type StrategyParams } from "./types.js";

/** Read an env var as a number, falling back to a default when unset/blank. */
export function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : Number(v);
}

/**
 * Build StrategyParams from environment overrides, falling back to DEFAULT_PARAMS.
 * SINGLE source of truth shared by the backtest (scripts/backtest.ts) and the live
 * engine (engine/deps.ts) so a new knob lands in ONE place and both paths read the
 * same config — the "one shared logic path / backtest-faithful" rule the bot is built on.
 */
export function paramsFromEnv(): StrategyParams {
  return {
    ...DEFAULT_PARAMS,
    atrStopMult: envNum("ATR_MULT", DEFAULT_PARAMS.atrStopMult),
    adxMin: envNum("ADX_MIN", DEFAULT_PARAMS.adxMin),
    maxHoldBars: envNum("MAX_HOLD_BARS", DEFAULT_PARAMS.maxHoldBars),
    stallBars: envNum("STALL_BARS", DEFAULT_PARAMS.stallBars),
    maxTotalBars: envNum("MAX_TOTAL_BARS", DEFAULT_PARAMS.maxTotalBars),
    donchianPeriod: envNum("DONCHIAN", DEFAULT_PARAMS.donchianPeriod),
    trailMult: envNum("TRAIL_MULT", DEFAULT_PARAMS.trailMult),
    takeFrac1: envNum("TAKE1", DEFAULT_PARAMS.takeFrac1),
    takeFrac2: envNum("TAKE2", DEFAULT_PARAMS.takeFrac2),
    cooldownBars: envNum("COOLDOWN", DEFAULT_PARAMS.cooldownBars),
    ema200SlopeLookback: envNum("EMA_SLOPE", DEFAULT_PARAMS.ema200SlopeLookback),
  };
}
