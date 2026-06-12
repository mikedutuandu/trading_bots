import { config } from "../config.js";
import type { Candle, Signal } from "../types.js";
import { DEFAULT_PARAMS, makeSignal, type IndicatorCtx, type Playbook, type StrategyParams } from "./types.js";

/**
 * Trend-pullback: trade with the EMA50/EMA200 trend, enter on a pullback to EMA20
 * that reclaims with a reversal candle. The reference bot's money-maker.
 */
export const trendPullback: Playbook = {
  name: "trend-pullback",
  detect(candles: Candle[], i: number, ind: IndicatorCtx, params: StrategyParams): Signal | null {
    const c = candles[i]!;
    const ema20 = ind.ema20[i];
    const ema50 = ind.ema50[i];
    const ema200 = ind.ema200[i];
    const atr = ind.atr14[i];
    const adx = ind.adx14[i];
    if (
      ema20 === undefined || ema50 === undefined || ema200 === undefined ||
      atr === undefined || Number.isNaN(ema20) || Number.isNaN(ema50) ||
      Number.isNaN(ema200) || Number.isNaN(atr) || atr <= 0
    ) {
      return null;
    }
    // Trend-strength gate (optional).
    if (params.adxMin > 0 && (adx === undefined || Number.isNaN(adx) || adx < params.adxMin)) {
      return null;
    }

    // EMA200-slope gate (optional): require the macro trend to be sloping with us.
    let slopeUp = true;
    let slopeDown = true;
    if (params.ema200SlopeLookback > 0) {
      const prev = ind.ema200[i - params.ema200SlopeLookback];
      if (prev === undefined || Number.isNaN(prev)) return null;
      slopeUp = ema200 > prev;
      slopeDown = ema200 < prev;
    }

    const bullish = c.close > c.open;
    const bearish = c.close < c.open;

    // Uptrend: pullback dips to/below EMA20 then closes back above with a green candle.
    if (ema50 > ema200 && slopeUp && c.low <= ema20 && c.close > ema20 && bullish) {
      const entry = c.close;
      const stop = entry - params.atrStopMult * atr;
      return makeSignal(
        {
          symbol: c.symbol,
          side: "long",
          playbook: "trend-pullback",
          setup: "pullback",
          timeframe: config.strategy.timeframe,
          entry,
          stop,
          reason: "uptrend pullback reclaim of EMA20",
        },
        params,
      );
    }

    // Downtrend: pullback pokes to/above EMA20 then closes back below with a red candle.
    if (ema50 < ema200 && slopeDown && c.high >= ema20 && c.close < ema20 && bearish) {
      const entry = c.close;
      const stop = entry + params.atrStopMult * atr;
      return makeSignal(
        {
          symbol: c.symbol,
          side: "short",
          playbook: "trend-pullback",
          setup: "pullback",
          timeframe: config.strategy.timeframe,
          entry,
          stop,
          reason: "downtrend pullback rejection of EMA20",
        },
        params,
      );
    }

    return null;
  },
};

export { DEFAULT_PARAMS };
