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
