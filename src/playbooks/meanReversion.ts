import { config } from "../config.js";
import type { Candle, Signal } from "../types.js";
import { makeSignal, type IndicatorCtx, type Playbook, type StrategyParams } from "./types.js";

/**
 * Mean-reversion — RESEARCHED 2026-06-17 and **REJECTED. DISABLED — do not enable** (kept in
 * the tree as a documented negative result, like trendBreakout). Not in resolvePlaybooks'
 * default; never runs live.
 *
 * Thesis (why it was tried): the trend-pullback edge is real but THIN because execution cost
 * eats ~83% of its gross edge, and a maker layer can't help a momentum ENTRY (adverse
 * selection). A mean-reversion entry — buy a deep OVERSOLD dip within an uptrend, revert to
 * the EMA20 mean — fills FAVORABLY as a resting limit, so it's the one entry style that could
 * capture the cheap-maker-execution prize.
 *
 * VERDICT (the fail-fast gate, `PLAYBOOKS=mean-reversion npm run backtest`, 45-symbol universe):
 * **no gross edge — PF 0.97 even at ZERO cost** (net −$236). It wins ~50% but avg win 0.81R <
 * avg loss 0.84R: small bounces banked, full −1R eaten when the dip keeps dipping (the
 * falling-knife tail risk). Since the SIGNAL is −EV before any cost, a maker layer (which only
 * cuts cost) cannot rescue it — there's no gross edge to protect. Contrast trend-pullback:
 * gross PF 1.37. So the maker prize needs a signal with a real gross edge AND maker-friendly
 * fills; trend has the edge but can't go maker, mean-reversion can go maker but has no edge.
 */
const OVERSOLD = 30;
const OVERBOUGHT = 70;

export const meanReversion: Playbook = {
  name: "mean-reversion",
  detect(candles: Candle[], i: number, ind: IndicatorCtx, params: StrategyParams): Signal | null {
    const c = candles[i]!;
    const ema20 = ind.ema20[i];
    const ema50 = ind.ema50[i];
    const ema200 = ind.ema200[i];
    const atr = ind.atr14[i];
    const rsi = ind.rsi14[i];
    if (
      ema20 === undefined || ema50 === undefined || ema200 === undefined ||
      atr === undefined || rsi === undefined || Number.isNaN(ema20) ||
      Number.isNaN(ema50) || Number.isNaN(ema200) || Number.isNaN(atr) ||
      Number.isNaN(rsi) || atr <= 0
    ) {
      return null;
    }

    // LONG: macro uptrend, price dipped BELOW the EMA20 mean, momentum oversold → expect a
    // bounce back toward the mean. Stop below the dip; the shared TP ladder takes the bounce.
    if (ema50 > ema200 && c.close < ema20 && rsi < OVERSOLD) {
      const entry = c.close;
      const stop = entry - params.atrStopMult * atr;
      return makeSignal(
        {
          symbol: c.symbol,
          side: "long",
          playbook: "mean-reversion",
          setup: "oversold-dip",
          timeframe: config.strategy.timeframe,
          entry,
          stop,
          reason: "oversold dip below EMA20 in an uptrend",
        },
        params,
      );
    }

    // SHORT: macro downtrend, price popped ABOVE the EMA20 mean, momentum overbought.
    if (ema50 < ema200 && c.close > ema20 && rsi > OVERBOUGHT) {
      const entry = c.close;
      const stop = entry + params.atrStopMult * atr;
      return makeSignal(
        {
          symbol: c.symbol,
          side: "short",
          playbook: "mean-reversion",
          setup: "overbought-pop",
          timeframe: config.strategy.timeframe,
          entry,
          stop,
          reason: "overbought pop above EMA20 in a downtrend",
        },
        params,
      );
    }

    return null;
  },
};
