import { config } from "../config.js";
import { logger } from "../logger.js";
import type { Candle, SymbolFilter } from "../types.js";
import { binance } from "./binance.js";

/** Raw kline tuple shape returned by /fapi/v1/klines. */
type RawKline = [
  number, // open time
  string, // open
  string, // high
  string, // low
  string, // close
  string, // volume
  number, // close time
  string, // quote asset volume
  number, // number of trades
  string, // taker buy base volume
  string, // taker buy quote volume
  string, // ignore
];

const KLINES_LIMIT = 1500; // Binance max per request

/**
 * Fetch up to `limit` recent candles, or page through history from `startTime`.
 * When `startTime` is set we walk forward until `endTime` (or now), 1500 at a time.
 */
export async function getKlines(
  symbol: string,
  interval: string,
  opts: { limit?: number; startTime?: number; endTime?: number } = {},
): Promise<Candle[]> {
  const out: Candle[] = [];

  if (opts.startTime === undefined) {
    const raw = await binance.publicGet<RawKline[]>("/fapi/v1/klines", {
      symbol,
      interval,
      limit: opts.limit ?? 500,
    });
    return raw.map((r) => toCandle(symbol, interval, r));
  }

  let cursor = opts.startTime;
  const end = opts.endTime ?? Date.now();
  // Guard against infinite loops if the API returns nothing.
  while (cursor < end) {
    const raw = await binance.publicGet<RawKline[]>("/fapi/v1/klines", {
      symbol,
      interval,
      startTime: cursor,
      endTime: end,
      limit: KLINES_LIMIT,
    });
    if (raw.length === 0) break;
    for (const r of raw) out.push(toCandle(symbol, interval, r));
    const lastOpen = raw[raw.length - 1]![0];
    if (lastOpen <= cursor) break; // no progress
    cursor = lastOpen + 1;
    if (raw.length < KLINES_LIMIT) break; // reached the end
  }
  return out;
}

function toCandle(symbol: string, interval: string, r: RawKline): Candle {
  return {
    symbol,
    interval,
    openTime: r[0],
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    closeTime: r[6],
  };
}

// ─── Exchange info (symbol filters) ──────────────────────────────────────────

interface RawExchangeInfo {
  symbols: Array<{
    symbol: string;
    contractType: string;
    status: string;
    quoteAsset: string;
    pricePrecision: number;
    quantityPrecision: number;
    filters: Array<Record<string, string>>;
  }>;
}

let filterCache: Map<string, SymbolFilter> | null = null;

export async function getExchangeInfo(): Promise<Map<string, SymbolFilter>> {
  if (filterCache) return filterCache;
  const info = await binance.publicGet<RawExchangeInfo>("/fapi/v1/exchangeInfo");
  const map = new Map<string, SymbolFilter>();
  for (const s of info.symbols) {
    if (s.contractType !== "PERPETUAL" || s.status !== "TRADING") continue;
    if (s.quoteAsset !== "USDT") continue;
    const price = s.filters.find((f) => f["filterType"] === "PRICE_FILTER");
    const lot = s.filters.find((f) => f["filterType"] === "LOT_SIZE");
    const notional = s.filters.find((f) => f["filterType"] === "MIN_NOTIONAL");
    if (!price || !lot) continue;
    map.set(s.symbol, {
      symbol: s.symbol,
      tickSize: Number(price["tickSize"]),
      stepSize: Number(lot["stepSize"]),
      minQty: Number(lot["minQty"]),
      minNotional: Number(notional?.["notional"] ?? 0),
      pricePrecision: s.pricePrecision,
      quantityPrecision: s.quantityPrecision,
    });
  }
  filterCache = map;
  logger.debug(`exchangeInfo: ${map.size} tradable USDT perpetuals`);
  return map;
}

export async function getSymbolFilter(symbol: string): Promise<SymbolFilter> {
  const map = await getExchangeInfo();
  const f = map.get(symbol);
  if (!f) throw new Error(`No exchangeInfo filter for ${symbol}`);
  return f;
}

// ─── Funding / mark price ────────────────────────────────────────────────────

export async function getMarkPrice(
  symbol: string,
): Promise<{ markPrice: number; lastFundingRate: number; nextFundingTime: number }> {
  const r = await binance.publicGet<{
    markPrice: string;
    lastFundingRate: string;
    nextFundingTime: number;
  }>("/fapi/v1/premiumIndex", { symbol });
  return {
    markPrice: Number(r.markPrice),
    lastFundingRate: Number(r.lastFundingRate),
    nextFundingTime: r.nextFundingTime,
  };
}

/** Raw row from /fapi/v1/fundingRate. */
interface RawFundingRate {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

const FUNDING_LIMIT = 1000; // Binance max per request

/**
 * Page through funding-rate history from `startTime` forward, 1000 settlements at
 * a time, mirroring getKlines. Funding settles every 8h on USDT-M perps.
 */
export async function getFundingHistory(
  symbol: string,
  opts: { startTime?: number; endTime?: number } = {},
): Promise<Array<{ symbol: string; fundingTime: number; rate: number }>> {
  const out: Array<{ symbol: string; fundingTime: number; rate: number }> = [];
  let cursor = opts.startTime ?? Date.now() - 7 * 24 * 60 * 60 * 1000;
  const end = opts.endTime ?? Date.now();

  while (cursor < end) {
    const raw = await binance.publicGet<RawFundingRate[]>("/fapi/v1/fundingRate", {
      symbol,
      startTime: cursor,
      endTime: end,
      limit: FUNDING_LIMIT,
    });
    if (raw.length === 0) break;
    for (const r of raw) {
      out.push({ symbol, fundingTime: r.fundingTime, rate: Number(r.fundingRate) });
    }
    const lastTime = raw[raw.length - 1]!.fundingTime;
    if (lastTime <= cursor) break; // no progress
    cursor = lastTime + 1;
    if (raw.length < FUNDING_LIMIT) break; // reached the end
  }
  return out;
}

// ─── Universe resolution ─────────────────────────────────────────────────────

interface Raw24h {
  symbol: string;
  quoteVolume: string;
}

/**
 * Resolve the tradable universe.
 * - static: returns configured SYMBOLS (filtered to tradable perps).
 * - dynamic: top-N USDT perpetuals by 24h quote volume, above the volume floor,
 *   excluding the denylist.
 */
export async function getUniverse(): Promise<string[]> {
  const filters = await getExchangeInfo();
  const deny = new Set(config.universe.denylist);

  if (config.universe.mode === "static") {
    if (config.universe.symbols.length === 0) {
      throw new Error("UNIVERSE_MODE=static but SYMBOLS is empty");
    }
    return config.universe.symbols.filter((s) => filters.has(s) && !deny.has(s));
  }

  const tickers = await binance.publicGet<Raw24h[]>("/fapi/v1/ticker/24hr");
  const ranked = tickers
    .filter((t) => filters.has(t.symbol) && !deny.has(t.symbol))
    .map((t) => ({ symbol: t.symbol, vol: Number(t.quoteVolume) }))
    .filter((t) => t.vol >= config.universe.min24hVolume)
    .sort((a, b) => b.vol - a.vol)
    .slice(0, config.universe.size)
    .map((t) => t.symbol);

  logger.debug(`universe: ${ranked.length} symbols (dynamic top ${config.universe.size})`);
  return ranked;
}
