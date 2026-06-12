import { config } from "../config.js";
import type { Candle, Signal } from "../types.js";
import { makeSignal, type IndicatorCtx, type Playbook, type StrategyParams } from "./types.js";

/**
 * Trend-breakout: trade with the EMA50/EMA200 trend, enter when price closes
 * beyond the Donchian channel (new N-bar extreme) — a breakout.
 */
export const trendBreakout: Playbook = {
  name: "trend-breakout",
  detect(candles: Candle[], i: number, ind: IndicatorCtx, params: StrategyParams): Signal | null {
    const c = candles[i]!;
    const ema50 = ind.ema50[i];
    const ema200 = ind.ema200[i];
    const atr = ind.atr14[i];
    const upper = ind.donchUpper[i];
    const lower = ind.donchLower[i];
    if (
      ema50 === undefined || ema200 === undefined || atr === undefined ||
      upper === undefined || lower === undefined ||
      Number.isNaN(ema50) || Number.isNaN(ema200) || Number.isNaN(atr) ||
      Number.isNaN(upper) || Number.isNaN(lower) || atr <= 0
    ) {
      return null;
    }

    // Uptrend breakout above the prior N-bar high.
    if (ema50 > ema200 && c.close > upper) {
      const entry = c.close;
      const stop = entry - params.atrStopMult * atr;
      return makeSignal(
        {
          symbol: c.symbol,
          side: "long",
          playbook: "trend-breakout",
          setup: "breakout",
          timeframe: config.strategy.timeframe,
          entry,
          stop,
          reason: "uptrend Donchian breakout",
        },
        params,
      );
    }

    // Downtrend breakdown below the prior N-bar low.
    if (ema50 < ema200 && c.close < lower) {
      const entry = c.close;
      const stop = entry + params.atrStopMult * atr;
      return makeSignal(
        {
          symbol: c.symbol,
          side: "short",
          playbook: "trend-breakout",
          setup: "breakout",
          timeframe: config.strategy.timeframe,
          entry,
          stop,
          reason: "downtrend Donchian breakdown",
        },
        params,
      );
    }

    return null;
  },
};
