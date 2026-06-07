import { config } from "../config.js";
import { logger } from "../logger.js";
import type { BtcUpDownEvent, GammaEvent, GammaMarket } from "../types.js";

// Polymarket Gamma series id for BTC Up or Down 5m (restricted=true, hidden from default /series listing).
// Discovery: GET /events?series_id=10684&closed=false&end_date_min=<ISO-now>
export const BTC_UPDOWN_5M_SERIES_ID = 10684;

export async function fetchEvents(opts: {
  seriesId?: number;
  closed?: boolean;
  endDateMin?: string; // ISO timestamp; events whose endDate >= this are returned
  endDateMax?: string; // ISO timestamp; events whose endDate <= this are returned
  order?: string;      // field to sort by, e.g. "endDate"
  ascending?: boolean;
  limit?: number;
  offset?: number;
} = {}): Promise<GammaEvent[]> {
  const params = new URLSearchParams();
  if (opts.seriesId !== undefined) params.set("series_id", String(opts.seriesId));
  if (opts.closed !== undefined) params.set("closed", String(opts.closed));
  if (opts.endDateMin) params.set("end_date_min", opts.endDateMin);
  if (opts.endDateMax) params.set("end_date_max", opts.endDateMax);
  if (opts.order) params.set("order", opts.order);
  if (opts.ascending !== undefined) params.set("ascending", String(opts.ascending));
  params.set("limit", String(opts.limit ?? 50));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));

  const url = `${config.polymarket.gammaUrl}/events?${params}`;
  logger.debug("GET", url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma /events failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as GammaEvent[];
}

function parseTokenIds(m: GammaMarket): [string, string] | null {
  try {
    const tokens = JSON.parse(m.clobTokenIds) as unknown;
    if (Array.isArray(tokens) && tokens.length >= 2) {
      const [up, down] = tokens as [string, string];
      if (up && down) return [up, down];
    }
  } catch { /* fall through */ }
  return null;
}

function pickPrimaryMarket(event: GammaEvent): GammaMarket | null {
  if (!event.markets?.length) return null;
  return event.markets.find((m) => m.active && !m.closed) ?? event.markets[0]!;
}

export function eventToBtcUpDown(event: GammaEvent): BtcUpDownEvent | null {
  const market = pickPrimaryMarket(event);
  if (!market) return null;
  const tokens = parseTokenIds(market);
  if (!tokens) return null;
  const [upTokenId, downTokenId] = tokens;
  const windowStartMs = event.startDate ? Date.parse(event.startDate) : Date.now();
  const windowEndMs = event.endDate ? Date.parse(event.endDate) : 0;
  if (!Number.isFinite(windowEndMs) || windowEndMs <= 0) return null;
  return {
    eventId: event.id,
    marketId: market.id,
    slug: event.slug,
    question: event.title,
    conditionId: market.conditionId,
    yesTokenId: upTokenId,
    noTokenId: downTokenId,
    windowStartMs,
    windowEndMs,
  };
}

export async function findActiveBtc5mEvents(nowMs: number = Date.now()): Promise<BtcUpDownEvent[]> {
  const events = await fetchEvents({
    seriesId: BTC_UPDOWN_5M_SERIES_ID,
    closed: false,
    endDateMin: new Date(nowMs).toISOString(),
    limit: 20,
  });
  const out: BtcUpDownEvent[] = [];
  for (const e of events) {
    const parsed = eventToBtcUpDown(e);
    if (parsed && parsed.windowEndMs > nowMs) out.push(parsed);
  }
  out.sort((a, b) => a.windowEndMs - b.windowEndMs);
  return out;
}

/** The market whose 5-minute window is currently open (start <= now < end). */
export function pickCurrentBtc5m(
  events: BtcUpDownEvent[],
  nowMs: number = Date.now(),
): BtcUpDownEvent | null {
  for (const e of events) {
    if (e.windowStartMs <= nowMs && nowMs < e.windowEndMs) return e;
  }
  return null;
}

export type PolymarketOutcome = "UP" | "DOWN" | "TIE";

/**
 * Fetch the resolved outcome for a settled 5m market by event slug.
 * Returns null if the market isn't yet settled (closed=false or outcomePrices not yet finalized).
 *
 * Polymarket settles ~30-60s after the window's end and sets `outcomePrices` to ["1","0"] (UP won),
 * ["0","1"] (DOWN won), or ["0.5","0.5"] (tie). The `closed` flag flips to true at the same time.
 */
export async function fetchSettledOutcome(slug: string): Promise<PolymarketOutcome | null> {
  const url = `${config.polymarket.gammaUrl}/events?slug=${encodeURIComponent(slug)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gamma /events?slug=${slug} failed: ${res.status}`);
  const events = (await res.json()) as GammaEvent[];
  const ev = events[0];
  if (!ev || !ev.closed) return null;
  const market = ev.markets?.[0];
  if (!market) return null;
  let prices: unknown;
  try { prices = JSON.parse(market.outcomePrices ?? "[]"); } catch { return null; }
  if (!Array.isArray(prices) || prices.length < 2) return null;
  const up = Number(prices[0]);
  const down = Number(prices[1]);
  if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
  // Settled markets have outcomes near 0/1. Allow small float noise.
  if (up >= 0.9 && down <= 0.1) return "UP";
  if (down >= 0.9 && up <= 0.1) return "DOWN";
  if (Math.abs(up - 0.5) < 0.05 && Math.abs(down - 0.5) < 0.05) return "TIE";
  return null; // not yet finalized
}
