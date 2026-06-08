import type { BestQuotes } from "../polymarket/clob.js";
import type { FairValueResult } from "../analysis/fairvalue.js";
import type { Side } from "../types.js";

export type { Side };

export interface SignalInputs {
  fair: FairValueResult;
  upQuotes: BestQuotes;
  downQuotes: BestQuotes;
  // strategy params
  minEdge: number;
  maxSpread: number;
  minRemainingSec?: number;
  maxRemainingSec?: number;
  remainingSec: number;
  // Realized vol guard — skip trades when annualized vol exceeds this. Data shows the model's
  // edge disappears in high-vol regimes; market correctly prices uncertainty.
  maxVol?: number;
  annualizedVol?: number;
  spot?: number;
  strike?: number;
  annualizedDrift?: number | null;
  blockAgainstTrend?: boolean;
  // Path A — UP-only mode with model-confidence threshold.
  upOnly?: boolean;
  // Contrarian mode: after the signal picks a side, bet the OPPOSITE side instead (UP<->DOWN).
  // Backtest verdict: this drops win rate ~66%->~34% and is net-negative OOS — enabled by explicit
  // STRATEGY_INVERT_SIGNAL only, as a deliberate experiment.
  invertSignal?: boolean;
  minFvUp?: number;
  // Path A refinements — only trade when bot mildly disagrees with market.
  maxEdge?: number;        // skip when bot disagrees with market too strongly
  minEntryPrice?: number;  // skip when market thinks our side is unlikely
  maxEntryPrice?: number;  // skip when market already prices our side as obvious — loss/win asymmetry too steep
  maxBtcMovedPct?: number; // reject when BTC already moved more than this fraction from window open (default 0.003 = 0.3%)
  minBtcMovedPct?: number; // reject when BTC has moved LESS than this fraction from window open — the "coin-flip" zone where the outcome is settlement noise the model can't predict (default 0 = off)
  requireTrendAgreement?: boolean; // when true, reject trades whose side disagrees with the sign of annualizedDrift (the ~30-min BTC trend). Live data: UP bets into a downtrend lost -$46; trading WITH the trend made +$59 vs -$23 against. (default false)
}

export interface SignalDecision {
  side: Side | null;
  reason: string;
  edge: number;             // fair - taken-price (for UP side; for DOWN it's flipped to a positive)
  takerPrice: number | null;
  bookSpread: number | null;
  fairUp: number;
  marketUp: number | null;  // mid of UP side
}

/**
 * Take the side where the fair-value probability exceeds the cost to enter (best ask).
 * For UP: edge_up = fair.pUp - upQuotes.bestAsk
 * For DOWN: edge_down = fair.pDown - downQuotes.bestAsk
 * Pick the larger, if it clears `minEdge` and spread is acceptable.
 */
export function decide(s: SignalInputs): SignalDecision {
  const marketUpMid = s.upQuotes.mid;

  if (s.minRemainingSec !== undefined && s.remainingSec < s.minRemainingSec) {
    return reject("too late in window", s.fair.pUp, marketUpMid);
  }
  if (s.maxRemainingSec !== undefined && s.remainingSec > s.maxRemainingSec) {
    return reject("too early in window", s.fair.pUp, marketUpMid);
  }
  if (s.maxVol !== undefined && s.annualizedVol !== undefined && s.annualizedVol > s.maxVol) {
    return reject(`vol ${s.annualizedVol.toFixed(3)} > ${s.maxVol}`, s.fair.pUp, marketUpMid);
  }

  const upAsk = s.upQuotes.bestAsk;
  const downAsk = s.downQuotes.bestAsk;
  const upSpread = s.upQuotes.spread;
  const downSpread = s.downQuotes.spread;

  const upEdge = upAsk !== null ? s.fair.pUp - upAsk : -Infinity;
  const downEdge = downAsk !== null ? s.fair.pDown - downAsk : -Infinity;

  const candidates: { side: Side; edge: number; price: number; spread: number | null }[] = [];
  if (upAsk !== null) {
    const fvOk = s.minFvUp === undefined || s.fair.pUp >= s.minFvUp;
    if (fvOk) candidates.push({ side: "UP", edge: upEdge, price: upAsk, spread: upSpread });
  }
  if (downAsk !== null && !s.upOnly) {
    // Symmetric: DOWN needs fv_down >= minFvUp (i.e. fv_up <= 1 - minFvUp).
    const fvOk = s.minFvUp === undefined || s.fair.pUp <= 1 - s.minFvUp;
    if (fvOk) candidates.push({ side: "DOWN", edge: downEdge, price: downAsk, spread: downSpread });
  }
  candidates.sort((a, b) => b.edge - a.edge);

  const best = candidates[0];
  if (!best) return reject("no orderbook", s.fair.pUp, marketUpMid);
  if (best.edge < s.minEdge) {
    return reject(`edge ${best.edge.toFixed(3)} < ${s.minEdge}`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
  }
  if (s.maxEdge !== undefined && best.edge > s.maxEdge) {
    return reject(`edge ${best.edge.toFixed(3)} > ${s.maxEdge} (disagrees with market too much)`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
  }
  if (s.minEntryPrice !== undefined && best.price < s.minEntryPrice) {
    return reject(`entry ${best.price.toFixed(2)} < ${s.minEntryPrice} (market disagrees with our side)`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
  }
  if (s.maxEntryPrice !== undefined && best.price > s.maxEntryPrice) {
    return reject(`entry ${best.price.toFixed(2)} > ${s.maxEntryPrice} (loss/win asymmetry too steep)`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
  }
  if (best.spread !== null && best.spread > s.maxSpread) {
    return reject(`spread ${best.spread.toFixed(3)} > ${s.maxSpread}`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
  }
  if (s.blockAgainstTrend !== false && s.spot !== undefined && s.strike !== undefined) {
    const priceTrend = s.spot - s.strike;
    if (best.side === "UP" && priceTrend < 0) {
      return reject(`UP signal but BTC below open (${priceTrend.toFixed(2)})`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
    }
    if (best.side === "DOWN" && priceTrend > 0) {
      return reject(`DOWN signal but BTC above open (+${priceTrend.toFixed(2)})`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
    }
    if (s.strike > 0) {
      const movedPct = Math.abs(priceTrend) / s.strike;
      const maxMoved = s.maxBtcMovedPct ?? 0.003;
      if (movedPct > maxMoved) {
        return reject(`BTC already moved ${(movedPct * 100).toFixed(2)}% from open — too far`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
      }
      const minMoved = s.minBtcMovedPct ?? 0;
      if (minMoved > 0 && movedPct < minMoved) {
        return reject(`BTC only moved ${(movedPct * 100).toFixed(2)}% from open — coin-flip zone, < ${(minMoved * 100).toFixed(2)}%`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
      }
    }
  }

  // Trend-agreement filter: only trade the side that agrees with the recent (~30-min) BTC
  // trend. Distinct from blockAgainstTrend (which uses within-window spot vs strike) — the
  // drift can point down over 30 min even while spot sits just above the window open. Live
  // data showed UP bets into a 30-min downtrend were the single losing behavior.
  if (s.requireTrendAgreement && s.annualizedDrift !== undefined && s.annualizedDrift !== null && s.annualizedDrift !== 0) {
    if (best.side === "UP" && s.annualizedDrift < 0) {
      return reject(`UP but recent BTC trend is down (drift ${s.annualizedDrift.toFixed(0)})`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
    }
    if (best.side === "DOWN" && s.annualizedDrift > 0) {
      return reject(`DOWN but recent BTC trend is up (drift +${s.annualizedDrift.toFixed(0)})`, s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
    }
  }

  if (s.invertSignal) {
    // Take the OPPOSITE side at its ask, keeping the original edge magnitude so position SIZE is
    // unchanged — only the side flips. The opposite ask must exist to enter.
    const flipped: Side = best.side === "UP" ? "DOWN" : "UP";
    const flippedAsk = flipped === "UP" ? s.upQuotes.bestAsk : s.downQuotes.bestAsk;
    if (flippedAsk === null) {
      return reject("invert: no opposite-side ask", s.fair.pUp, marketUpMid, best.edge, best.price, best.spread);
    }
    return {
      side: flipped,
      reason: "inverted",
      edge: best.edge,
      takerPrice: flippedAsk,
      bookSpread: flipped === "UP" ? s.upQuotes.spread : s.downQuotes.spread,
      fairUp: s.fair.pUp,
      marketUp: marketUpMid,
    };
  }

  return {
    side: best.side,
    reason: "edge",
    edge: best.edge,
    takerPrice: best.price,
    bookSpread: best.spread,
    fairUp: s.fair.pUp,
    marketUp: marketUpMid,
  };
}

function reject(
  reason: string,
  fairUp: number,
  marketUp: number | null,
  edge = 0,
  takerPrice: number | null = null,
  bookSpread: number | null = null,
): SignalDecision {
  return { side: null, reason, edge, takerPrice, bookSpread, fairUp, marketUp };
}
