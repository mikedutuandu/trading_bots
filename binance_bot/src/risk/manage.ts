import type { Candle, CloseReason, Side } from "../types.js";

/** Kind of a fill produced while managing a position. */
export type FillKind = "TP1" | "TP2" | "STOP" | "MANAGED_STOP" | "HEALTH_CLOSE";

export interface Fill {
  price: number;
  qty: number;
  kind: FillKind;
}

/** Mutable runtime state of an open position (used by backtest & live engine). */
export interface RuntimePosition {
  side: Side;
  entry: number;
  stop: number; // mutable: breakeven after TP1, +1R after TP2, then trails
  tp1: number;
  tp2: number;
  tp3: number; // reference target only; runner trails past it
  qtyTotal: number;
  qtyRemaining: number;
  qtyTp1: number; // quantity taken at TP1
  qtyTp2: number; // quantity taken at TP2; the remainder trails
  tp1Hit: boolean;
  tp2Hit: boolean;
  trailActive: boolean; // true after TP2 → final third trails
  trailExtreme: number; // highest high (long) / lowest low (short) since entry
  openedAtBar: number;
}

export interface ManageCtx {
  bar: number; // current bar index
  trendUp: boolean; // ema50 > ema200 at this bar
  atr: number; // ATR at this bar (for the chandelier trail)
  trailMult: number; // ATR multiple for the trailing stop
  maxHoldBars: number; // 0 disables; else time-stop a pre-TP1 trade (never reached +1R) after N bars
  stallBars: number; // 0 disables; else close a TP1-hit-but-not-TP2 trade after N bars (frees the slot)
  maxTotalBars: number; // 0 disables; else hard age cap on ANY trade (closes runners too)
}

/** Map the final fill kind to the trade's CloseReason. */
export function closeReasonOf(kind: FillKind): CloseReason {
  switch (kind) {
    case "STOP":
      return "STOP";
    case "MANAGED_STOP":
      return "MANAGED_STOP";
    case "HEALTH_CLOSE":
      return "HEALTH_CLOSE";
    default:
      return "TP3"; // shouldn't happen as a final reason, but keep exhaustive
  }
}

/**
 * Process one candle against an open position. Mutates `pos` and returns the fills.
 *
 * Exit structure (the fix that lets winners run):
 *   - TP1 (+1R): take 1/3, move stop to breakeven (capital protected).
 *   - TP2 (+2R): take 1/3, move stop to +1R (profit locked), arm the trailing stop.
 *   - Final 1/3: NO fixed target — trail a chandelier stop (extreme ∓ k*ATR) so it
 *     can run to +5R/+10R in a strong trend. Exits via trail, trend-flip, or stop.
 * Pessimistic: within a candle, the stop is assumed to trigger before any target.
 */
export function manageOnCandle(pos: RuntimePosition, c: Candle, ctx: ManageCtx): {
  fills: Fill[];
  closed: boolean;
} {
  const fills: Fill[] = [];
  const long = pos.side === "long";

  // Tighten the trailing stop using the extreme through the PRIOR bar (no same-bar lookahead).
  if (pos.trailActive && ctx.atr > 0 && Number.isFinite(ctx.atr)) {
    const trail = long
      ? pos.trailExtreme - ctx.trailMult * ctx.atr
      : pos.trailExtreme + ctx.trailMult * ctx.atr;
    pos.stop = long ? Math.max(pos.stop, trail) : Math.min(pos.stop, trail);
  }

  // 1. Stop check (pessimistic — assume worst case first).
  const stopHit = long ? c.low <= pos.stop : c.high >= pos.stop;
  if (stopHit) {
    fills.push({ price: pos.stop, qty: pos.qtyRemaining, kind: pos.tp1Hit ? "MANAGED_STOP" : "STOP" });
    pos.qtyRemaining = 0;
    return { fills, closed: true };
  }

  // 2. Take-profit ladder (TP1, TP2 only; the final third trails).
  const reach = (target: number) => (long ? c.high >= target : c.low <= target);

  if (!pos.tp1Hit && reach(pos.tp1)) {
    if (pos.qtyTp1 > 0) {
      fills.push({ price: pos.tp1, qty: pos.qtyTp1, kind: "TP1" });
      pos.qtyRemaining -= pos.qtyTp1;
    }
    pos.tp1Hit = true;
    pos.stop = long ? Math.max(pos.stop, pos.entry) : Math.min(pos.stop, pos.entry); // breakeven
  }
  if (pos.tp1Hit && !pos.tp2Hit && reach(pos.tp2)) {
    if (pos.qtyTp2 > 0) {
      fills.push({ price: pos.tp2, qty: pos.qtyTp2, kind: "TP2" });
      pos.qtyRemaining -= pos.qtyTp2;
    }
    pos.tp2Hit = true;
    pos.stop = long ? Math.max(pos.stop, pos.tp1) : Math.min(pos.stop, pos.tp1); // lock +1R
    pos.trailActive = true; // arm the trail for the runner
  }

  // 3. Health close at candle close: trend flipped, or one of three lifecycle
  //    time-stops. All gate on `> 0` (0 = disabled) and partition the trade's life:
  //   - deadTimeout: never reached +1R within maxHoldBars (a dead trade).
  //   - stallTimeout: hit TP1 but not TP2 within stallBars (riding breakeven, ties up a slot).
  //   - globalTimeout: hard age cap on ANY trade incl. a post-TP2 runner ("time is money").
  const trendFlipped = long ? !ctx.trendUp : ctx.trendUp;
  const heldBars = ctx.bar - pos.openedAtBar;
  const deadTimeout = ctx.maxHoldBars > 0 && !pos.tp1Hit && heldBars >= ctx.maxHoldBars;
  const stallTimeout = ctx.stallBars > 0 && pos.tp1Hit && !pos.tp2Hit && heldBars >= ctx.stallBars;
  const globalTimeout = ctx.maxTotalBars > 0 && heldBars >= ctx.maxTotalBars;
  if (trendFlipped || deadTimeout || stallTimeout || globalTimeout) {
    fills.push({ price: c.close, qty: pos.qtyRemaining, kind: "HEALTH_CLOSE" });
    pos.qtyRemaining = 0;
    return { fills, closed: true };
  }

  // 4. Update the trailing extreme for the next bar.
  pos.trailExtreme = long ? Math.max(pos.trailExtreme, c.high) : Math.min(pos.trailExtreme, c.low);

  return { fills, closed: false };
}
