export interface SizingInputs {
  bankrollUsd: number;
  edge: number;           // P(win) - taker_price, on a per-share basis
  takerPrice: number;     // entry price, 0..1
  maxRiskFraction: number; // e.g. 0.05 — cap risk per trade at 5% of bankroll
  /**
   * Kelly multiplier — full Kelly = 1.0, half-Kelly = 0.5. Recommend 0.25–0.5 for noisy edges.
   */
  kellyFraction: number;
}

/**
 * Binary Kelly: f* = (p * b - q) / b, where p = win prob, q = 1 - p, b = payoff/risk ratio.
 * For a Polymarket share bought at `c` that pays 1 on win: payoff = (1 - c)/c = b, q = 1 - p.
 * f* = (p*(1-c)/c - (1-p)) / ((1-c)/c) = (p - c) / (1 - c).
 *
 * Returns USD to put at risk (i.e. number_of_shares * taker_price).
 */
export function kellyRiskUsd(s: SizingInputs): number {
  const p = s.takerPrice + s.edge; // fair win probability
  if (p <= 0 || p >= 1) return 0;
  const c = s.takerPrice;
  if (c <= 0 || c >= 1) return 0;
  const fStar = (p - c) / (1 - c);
  if (fStar <= 0) return 0;
  const fApplied = Math.min(fStar * s.kellyFraction, s.maxRiskFraction);
  return Math.max(0, fApplied * s.bankrollUsd);
}

/** Convert USD risk into a share count, given the taker price (per share, in USD). */
export function sharesFromRiskUsd(riskUsd: number, takerPrice: number): number {
  if (takerPrice <= 0) return 0;
  return riskUsd / takerPrice;
}
