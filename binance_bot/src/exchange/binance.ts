import { createHmac } from "node:crypto";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * Thin native client for the Binance USDT-M Futures REST API (`fapi`).
 * Handles HMAC-SHA256 signing, server-time sync, rate-limit awareness, and retries.
 * We deliberately avoid ccxt to keep full control over requests.
 */

type Params = Record<string, string | number | boolean | undefined>;

/** A failed Binance REST call, carrying the structured API `code` (e.g. -2011). */
export class BinanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | null,
    readonly apiMsg: string,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = "BinanceApiError";
  }
}

/** True when `err` is a Binance API error with the given code (replaces message matching). */
export function isBinanceCode(err: unknown, code: number): boolean {
  return err instanceof BinanceApiError && err.code === code;
}

/** One-line, stack-free description of any error for logs (e.g. "-4131 The counterparty's…"). */
export function briefError(err: unknown): string {
  if (err instanceof BinanceApiError) return `${err.code ?? err.status} ${err.apiMsg}`.trim();
  return err instanceof Error ? err.message : String(err);
}

let timeOffsetMs = 0; // serverTime - localTime, refreshed periodically
let lastUsedWeight = 0;
// Effective REST host + credentials. Default to the mainnet config; venue
// selection (testnet vs mainnet) overrides both via setBaseUrl/setCredentials.
let baseUrl = config.binance.baseUrl;
let apiKey = config.binance.apiKey;
let apiSecret = config.binance.apiSecret;

export function getUsedWeight(): number {
  return lastUsedWeight;
}

export function getBaseUrl(): string {
  return baseUrl;
}

export function setBaseUrl(url: string): void {
  baseUrl = url;
  logger.info(`binance REST base set to ${url}`);
}

export function setCredentials(key: string, secret: string): void {
  apiKey = key;
  apiSecret = secret;
}

function buildQuery(params: Params): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.append(k, String(v));
  }
  return usp.toString();
}

function sign(query: string): string {
  return createHmac("sha256", apiSecret).update(query).digest("hex");
}

async function rawFetch(
  method: "GET" | "POST" | "DELETE" | "PUT",
  path: string,
  query: string,
  signed: boolean,
): Promise<Response> {
  const url = `${baseUrl}${path}${query ? `?${query}` : ""}`;
  const headers: Record<string, string> = {};
  if (signed || apiKey) headers["X-MBX-APIKEY"] = apiKey;
  return fetch(url, { method, headers });
}

const MAX_RETRIES = 3;

async function request<T>(
  method: "GET" | "POST" | "DELETE" | "PUT",
  path: string,
  params: Params = {},
  signed = false,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let query = buildQuery(params);
    if (signed) {
      // Must be an integer ms epoch; the synced offset can be fractional, so round.
      const ts = Math.round(Date.now() + timeOffsetMs);
      const withTs = `${query}${query ? "&" : ""}timestamp=${ts}&recvWindow=${config.binance.recvWindow}`;
      query = `${withTs}&signature=${sign(withTs)}`;
    }

    let res: Response;
    try {
      res = await rawFetch(method, path, query, signed);
    } catch (err) {
      logger.warn(`network error on ${path} (attempt ${attempt}):`, err);
      await sleep(backoff(attempt));
      continue;
    }

    const weight = res.headers.get("x-mbx-used-weight-1m");
    if (weight) lastUsedWeight = Number(weight);

    if (res.ok) {
      return (await res.json()) as T;
    }

    const body = await res.text();
    // 418/429 = rate limited, 5xx = transient → retry with backoff
    if (res.status === 429 || res.status === 418 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after") ?? 0) * 1000;
      logger.warn(`HTTP ${res.status} on ${path} (attempt ${attempt}): ${body}`);
      await sleep(Math.max(retryAfter, backoff(attempt)));
      continue;
    }

    let code: number | null = null;
    let apiMsg = "";
    try {
      const parsed = JSON.parse(body) as { code?: number; msg?: string };
      if (typeof parsed.code === "number") code = parsed.code;
      if (typeof parsed.msg === "string") apiMsg = parsed.msg;
    } catch {
      /* non-JSON error body (e.g. an HTML 502) — leave code/msg unset */
    }
    throw new BinanceApiError(res.status, code, apiMsg, body, `Binance ${method} ${path} failed: HTTP ${res.status} ${body}`);
  }
  throw new Error(`Binance ${method} ${path} failed after ${MAX_RETRIES} retries`);
}

function backoff(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 8000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sync local clock with Binance server time to avoid -1021 timestamp errors. */
export async function syncTime(): Promise<void> {
  const before = Date.now();
  const { serverTime } = await request<{ serverTime: number }>("GET", "/fapi/v1/time");
  const rtt = Date.now() - before;
  timeOffsetMs = Math.round(serverTime - (Date.now() - rtt / 2));
  logger.debug(`time synced, offset=${timeOffsetMs}ms`);
}

export const binance = {
  syncTime,
  getUsedWeight,
  getBaseUrl,
  setBaseUrl,
  setCredentials,
  /** Public (unsigned) GET. */
  publicGet: <T>(path: string, params?: Params) => request<T>("GET", path, params, false),
  /** Signed GET (account/positions). */
  signedGet: <T>(path: string, params?: Params) => request<T>("GET", path, params, true),
  /** Signed POST (place order, set leverage). */
  signedPost: <T>(path: string, params?: Params) => request<T>("POST", path, params, true),
  /** Signed DELETE (cancel order). */
  signedDelete: <T>(path: string, params?: Params) =>
    request<T>("DELETE", path, params, true),
  // ── Unsigned but API-keyed (listenKey lifecycle): key header, no HMAC ──
  keyedPost: <T>(path: string, params?: Params) => request<T>("POST", path, params, false),
  keyedPut: <T>(path: string, params?: Params) => request<T>("PUT", path, params, false),
  keyedDelete: <T>(path: string, params?: Params) =>
    request<T>("DELETE", path, params, false),
};
