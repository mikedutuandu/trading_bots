import { config } from "../config.js";
import { logger } from "../logger.js";
import type { OrderBookSummary } from "../types.js";

export async function getOrderBook(tokenId: string): Promise<OrderBookSummary> {
  const url = `${config.polymarket.clobUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
  logger.debug("GET", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CLOB /book failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as OrderBookSummary;
}

export interface PricePoint {
  t: number; // unix seconds
  p: number; // price 0..1
}

/**
 * Historical price series for a CLOB token. `fidelity` is the resolution in MINUTES
 * (1 = finest). For the thinly-traded 5m markets the endpoint only returns points where
 * something actually traded/updated — typically a handful per window, NOT a regular grid.
 * Returns points sorted ascending by time; [] on any failure (caller decides whether to retry).
 */
export async function fetchPricesHistory(
  tokenId: string,
  startTs: number,
  endTs: number,
  fidelity = 1,
): Promise<PricePoint[]> {
  const params = new URLSearchParams({
    market: tokenId,
    startTs: String(startTs),
    endTs: String(endTs),
    fidelity: String(fidelity),
  });
  const url = `${config.polymarket.clobUrl}/prices-history?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CLOB /prices-history failed: ${res.status}`);
  const json = (await res.json()) as { history?: { t: number; p: number }[] };
  const hist = json.history ?? [];
  return hist
    .filter((h) => Number.isFinite(h.t) && Number.isFinite(h.p))
    .map((h) => ({ t: h.t, p: h.p }))
    .sort((a, b) => a.t - b.t);
}

export interface BestQuotes {
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
}

export function bestQuotes(book: OrderBookSummary): BestQuotes {
  let bestBid: number | null = null;
  for (const l of book.bids) {
    const p = Number(l.price);
    const s = Number(l.size);
    if (!(p > 0) || !(s > 0)) continue;
    if (bestBid === null || p > bestBid) bestBid = p;
  }
  let bestAsk: number | null = null;
  for (const l of book.asks) {
    const p = Number(l.price);
    const s = Number(l.size);
    if (!(p > 0) || !(s > 0)) continue;
    if (bestAsk === null || p < bestAsk) bestAsk = p;
  }
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  return { bestBid, bestAsk, mid, spread };
}
