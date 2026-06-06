export type Side = "UP" | "DOWN";

/** True if a position on `side` wins when the market's UP outcome is `upWon`. */
export function sideWins(side: Side, upWon: boolean): boolean {
  return (side === "UP") === upWon;
}

export interface GammaEvent {
  id: string;
  ticker?: string;
  slug: string;
  title: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  active: boolean;
  closed: boolean;
  archived?: boolean;
  markets: GammaMarket[];
}

export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  active: boolean;
  closed: boolean;
  endDate?: string;
  startDate?: string;
  clobTokenIds: string;
  outcomes: string;
  outcomePrices?: string;
  volume?: string;
  liquidity?: string;
}

export interface BtcUpDownEvent {
  eventId: string;
  marketId: string;
  slug: string;
  question: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
  windowStartMs: number;
  windowEndMs: number;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBookSummary {
  market: string;
  asset_id: string;
  timestamp: string;
  hash: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
}

export interface BtcPriceTick {
  ts: number;
  price: number;
  bid?: number;
  ask?: number;
}

export interface CollectorTick {
  ts: number;
  windowStartMs: number;
  windowEndMs: number;
  marketSlug: string;
  upBestBid: number | null;
  upBestAsk: number | null;
  upMid: number | null;
  downBestBid: number | null;
  downBestAsk: number | null;
  downMid: number | null;
  btcPrice: number;
  btcPriceAtWindowStart: number | null;
  realizedVol1m: number | null;
  fairValueUp: number | null;
  edgeUp: number | null;      // fair.pUp - upBestAsk (positive = buy UP looks good)
  edgeDown: number | null;    // fair.pDown - downBestAsk
}
