import { normalCdf } from "./normal.js";

export interface FairValueInputs {
  spot: number;              // current BTC price
  strike: number;            // BTC price at the start of the 5m window (the "barrier")
  remainingSeconds: number;  // time left until window close
  annualizedVol: number;     // realized vol from RollingRealizedVol
  drift?: number;            // annualized drift (default 0 — we assume martingale)
}

export interface FairValueResult {
  pUp: number;   // P(spot_at_close > strike)
  pDown: number; // 1 - pUp
}

const SECONDS_PER_YEAR = 60 * 60 * 24 * 365;

/**
 * Lognormal model: ln(S_T/S_0) ~ Normal((mu - sigma^2/2) T, sigma^2 T).
 * Under risk-neutral assumption (no drift), P(S_T > K) reduces to
 * P(Z > -d2) = N(d2) where
 *   d2 = (ln(S/K) - 0.5 * sigma^2 * T) / (sigma * sqrt(T))
 *
 * For our case, the "strike" K is the price at the start of the 5m window
 * (window resolves UP if S_T >= S_0), but our "spot" S is the *current* price
 * partway into the window. We're computing P(S_T > K | S_now = spot).
 */
export function fairValue({
  spot,
  strike,
  remainingSeconds,
  annualizedVol,
  drift = 0,
}: FairValueInputs): FairValueResult | null {
  if (!Number.isFinite(spot) || !Number.isFinite(strike) || spot <= 0 || strike <= 0) return null;
  if (!Number.isFinite(annualizedVol) || annualizedVol <= 0) return null;
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
    // Window already over; collapse to deterministic outcome
    return { pUp: spot > strike ? 1 : 0, pDown: spot > strike ? 0 : 1 };
  }

  const T = remainingSeconds / SECONDS_PER_YEAR;
  const sigmaSqrtT = annualizedVol * Math.sqrt(T);
  if (sigmaSqrtT === 0) return { pUp: spot > strike ? 1 : 0, pDown: spot > strike ? 0 : 1 };
  const d2 = (Math.log(spot / strike) + (drift - 0.5 * annualizedVol * annualizedVol) * T) / sigmaSqrtT;
  const pUp = normalCdf(d2);
  return { pUp, pDown: 1 - pUp };
}

/**
 * Bayesian blend of the BS-derived pUp with Polymarket's implied probability.
 *
 * Market mid aggregates flow / informed-trader information that the BS model is
 * blind to. Past live data showed the BS model is overconfident — when it
 * strongly disagreed with the market, the market was usually right. Blending
 * dampens that overconfidence.
 *
 * Returns fv unchanged when marketProbUp is null or weight <= 0.
 */
export function blendWithMarket(
  fv: FairValueResult,
  marketProbUp: number | null,
  weight: number,
): FairValueResult {
  if (marketProbUp === null || !Number.isFinite(marketProbUp) || weight <= 0) return fv;
  const w = Math.min(1, weight);
  const pUp = w * marketProbUp + (1 - w) * fv.pUp;
  return { pUp, pDown: 1 - pUp };
}
