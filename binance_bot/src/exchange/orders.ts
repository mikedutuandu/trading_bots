import type { Side, SymbolFilter } from "../types.js";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { roundToStep, roundToTick } from "../risk/sizing.js";
import { AmbiguousOrderError, binance, briefError, isBinanceCode } from "./binance.js";

/**
 * Order placement / cancellation for USDT-M Futures, assuming **one-way** position
 * mode (the default). Side mapping:
 *   open  long  → BUY     | open  short → SELL
 *   close long  → SELL    | close short → BUY  (reduceOnly)
 * Prices/quantities are rounded to the symbol's tick/step before sending.
 */

const orderSide = (tradeSide: Side, closing: boolean): "BUY" | "SELL" => {
  const openBuy = tradeSide === "long";
  return (closing ? !openBuy : openBuy) ? "BUY" : "SELL";
};

let seq = 0;
/** Deterministic-ish client order id for idempotency / log correlation. seq + full ms
 *  timestamp come FIRST so the 36-char cap can only truncate the symbol suffix — the
 *  uniqueness discriminator survives even for long symbol names (the id is load-bearing:
 *  ambiguous-POST recovery looks orders up by it). */
function clientOrderId(tag: string, symbol: string): string {
  return `b3-${tag}-${seq++}-${Date.now()}-${symbol}`.slice(0, 36);
}

interface RawOrder {
  orderId: number;
  clientOrderId: string;
  symbol: string;
  status: string;
  avgPrice: string;
  executedQty: string;
  cumQuote: string;
  side: string;
}

interface RawUserTrade {
  price: string;
  qty: string;
  commission: string;
  commissionAsset: string;
  realizedPnl: string;
  orderId: number;
  time: number;
}

export interface OrderFill {
  orderId: number;
  price: number; // average fill price
  qty: number; // filled quantity (absolute)
  commission: number; // USDT commission for this order
}

/** Estimated taker fee for a fill whose real commission is unreadable (userTrades
 *  unavailable, non-USDT fee asset, adopted fill) — better than journalling 0. */
export function estimateTakerFee(price: number, qty: number): number {
  return config.risk.takerFee * price * qty;
}

/** The order EXECUTED on the exchange (we hold its orderId) but no usable fill price
 *  could be read from the response, cumQuote, or userTrades. Distinct from a rejected
 *  order: callers may safely recover from exchange truth (the fill is real). */
export class FilledButUnreadableError extends Error {
  constructor(message: string, readonly orderId: number) {
    super(message);
    this.name = "FilledButUnreadableError";
  }
}

/**
 * Sum the userTrades for one order → precise average fill price + commission.
 * Commission sums the USDT amounts; a non-USDT fee asset (e.g. BNB fee payment) is
 * flagged via `nonUsdtFee` so the caller substitutes a taker-fee estimate.
 */
async function fillsForOrder(
  symbol: string,
  orderId: number,
): Promise<{ price: number; qty: number; commission: number; nonUsdtFee: boolean }> {
  const trades = await binance.signedGet<RawUserTrade[]>("/fapi/v1/userTrades", {
    symbol,
    orderId,
  });
  let qty = 0;
  let quote = 0;
  let commission = 0;
  let nonUsdtFee = false;
  for (const t of trades) {
    const q = Number(t.qty);
    qty += q;
    quote += q * Number(t.price);
    if (t.commissionAsset === "USDT") commission += Number(t.commission);
    else nonUsdtFee = true; // e.g. BNB fee payment — estimated by the caller, not dropped
  }
  return { price: qty > 0 ? quote / qty : 0, qty, commission, nonUsdtFee };
}

/** After an ambiguous order POST (network error / 5xx — the order MAY have executed),
 *  resolve the truth by looking the order up by our client id. Found → return it so the
 *  caller proceeds with the real fill; confirmed absent → return null (safe to fail). */
async function findOrderByClientId(symbol: string, origClientOrderId: string): Promise<RawOrder | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    await new Promise((r) => setTimeout(r, 1000 * attempt));
    try {
      return await binance.signedGet<RawOrder>("/fapi/v1/order", { symbol, origClientOrderId });
    } catch (err) {
      if (isBinanceCode(err, -2013)) return null; // "Order does not exist" → never placed
      logger.warn(`${symbol}: order lookup ${origClientOrderId} failed (attempt ${attempt}): ${briefError(err)}`);
    }
  }
  return null;
}

/** Place a market order (open or reduceOnly close) and return the realized fill. */
export async function placeMarketOrder(
  symbol: string,
  tradeSide: Side,
  qty: number,
  filter: SymbolFilter,
  opts: { reduceOnly?: boolean; tag?: string } = {},
): Promise<OrderFill> {
  const rounded = roundToStep(qty, filter.stepSize);
  if (rounded <= 0) throw new Error(`${symbol} market qty rounds to 0 (qty=${qty}, step=${filter.stepSize})`);

  const cid = clientOrderId(opts.tag ?? "mkt", symbol);
  let order: RawOrder;
  try {
    order = await binance.signedPost<RawOrder>("/fapi/v1/order", {
      symbol,
      side: orderSide(tradeSide, opts.reduceOnly ?? false),
      type: "MARKET",
      quantity: rounded,
      reduceOnly: opts.reduceOnly ? "true" : undefined,
      newClientOrderId: cid,
      newOrderRespType: "RESULT",
    });
  } catch (err) {
    if (!(err instanceof AmbiguousOrderError)) throw err;
    // The POST died after the exchange may have processed it. NEVER blind-retry a market
    // order (a second fill doubles the position) — ask the exchange whether ours exists.
    logger.warn(`${symbol}: ambiguous order POST (${briefError(err)}) — verifying by client id ${cid}`);
    const found = await findOrderByClientId(symbol, cid);
    if (!found) throw err; // confirmed not placed → safe to surface the failure
    logger.warn(`${symbol}: ambiguous POST actually executed (orderId ${found.orderId}) — recovered, no duplicate sent`);
    order = found;
  }

  // Prefer precise fills from userTrades; fall back to the order response.
  let price = Number(order.avgPrice);
  let filled = Number(order.executedQty);
  // A RESULT response can omit/blank avgPrice → NaN. Recover the VWAP from cumQuote/qty
  // so a junk price never propagates into settleFill → grossPnl (which corrupts a closed
  // trade's PnL to NaN/NULL). Seen on the demo venue's reduceOnly market exits.
  if (!Number.isFinite(price) || price <= 0) {
    const cq = Number(order.cumQuote);
    if (Number.isFinite(cq) && Number.isFinite(filled) && filled > 0) price = cq / filled;
  }
  let commission = 0;
  let feeFromTrades = false;
  try {
    const f = await fillsForOrder(symbol, order.orderId);
    if (f.qty > 0) {
      price = f.price;
      filled = f.qty;
      commission = f.commission;
      feeFromTrades = true;
      // Fee paid in a non-USDT asset (BNB fee payment): the USDT sum above misses it —
      // estimate the taker fee instead of journalling ~0 (which overstates every netPnl).
      if (f.nonUsdtFee && commission === 0) {
        commission = estimateTakerFee(f.price, f.qty);
        logger.warn(`${symbol} order ${order.orderId}: non-USDT commission — journalling taker-fee estimate ${commission.toFixed(4)}`);
      }
    }
  } catch (err) {
    logger.warn(`${symbol} could not read userTrades for order ${order.orderId}:`, err);
  }
  // Last resort: never return a non-finite fill price. The typed throw tells callers the
  // order DID execute (orderId is real) — the reduce path's reconcile journals it from
  // exchange truth next tick, and the entry path may adopt the position instead of
  // leaving it untracked. Never a NaN close either way.
  if (!Number.isFinite(price) || price <= 0) {
    throw new FilledButUnreadableError(
      `${symbol} order ${order.orderId}: no usable fill price (avgPrice='${order.avgPrice}', cumQuote='${order.cumQuote}')`,
      order.orderId,
    );
  }
  // If userTrades was unreadable, estimate the taker fee instead of journalling 0
  // (mirrors the reconcileFlat fee-estimate convention).
  if (!feeFromTrades) commission = estimateTakerFee(price, filled);
  logger.info(
    `${opts.reduceOnly ? "REDUCE" : "OPEN"} ${symbol} ${tradeSide} qty=${filled} @ ${price} fee=${commission.toFixed(4)}`,
  );
  return { orderId: order.orderId, price, qty: filled, commission };
}

/**
 * Place a protective STOP_MARKET that closes the WHOLE remaining position when the
 * mark price crosses the trigger. `closePosition=true` auto-sizes and auto-cancels
 * it when the position flattens — a safety net behind the bot's candle-close manage.
 *
 * Since 2025-12-09 Binance moved conditional orders (STOP_MARKET/TAKE_PROFIT_MARKET/
 * TRAILING_STOP_MARKET/…) OFF /fapi/v1/order (which now returns -4120) onto the Algo
 * endpoint /fapi/v1/algoOrder with algoType=CONDITIONAL. Returns the `algoId`.
 */
export async function placeProtectiveStop(
  symbol: string,
  tradeSide: Side,
  stopPrice: number,
  filter: SymbolFilter,
): Promise<number> {
  const order = await binance.signedPost<{ algoId: number }>("/fapi/v1/algoOrder", {
    algoType: "CONDITIONAL",
    symbol,
    side: orderSide(tradeSide, true), // closing side
    type: "STOP_MARKET",
    triggerPrice: roundToTick(stopPrice, filter.tickSize),
    closePosition: "true",
    workingType: "MARK_PRICE",
    clientAlgoId: clientOrderId("sl", symbol),
  });
  return order.algoId;
}

export async function cancelOrder(symbol: string, orderId: number | string): Promise<void> {
  try {
    await binance.signedDelete("/fapi/v1/order", { symbol, orderId });
  } catch (err) {
    // -2011 = unknown order (already filled/cancelled). Safe to ignore.
    if (isBinanceCode(err, -2011)) {
      logger.debug(`${symbol} order ${orderId} already gone`);
      return;
    }
    throw err;
  }
}

/** Cancel a conditional (algo) order by algoId via DELETE /fapi/v1/algoOrder.
 *  Best-effort: never throws — a failed cancel of an already-gone stop (e.g. a
 *  closePosition stop auto-cancelled when the position flattened) must not block
 *  placing the replacement. Unexpected errors are logged at warn so they're visible. */
export async function cancelAlgoOrder(symbol: string, algoId: number | string): Promise<void> {
  try {
    await binance.signedDelete("/fapi/v1/algoOrder", { symbol, algoId });
  } catch (err) {
    // -2011 = unknown order (already filled/cancelled/auto-cancelled). Expected, ignore.
    if (isBinanceCode(err, -2011)) return;
    logger.warn(`${symbol} algo order ${algoId} cancel failed: ${briefError(err)}`);
  }
}

export async function cancelAllOrders(symbol: string): Promise<void> {
  await binance.signedDelete("/fapi/v1/allOpenOrders", { symbol });
}

/** Open conditional (algo) orders, optionally for one symbol. GET /fapi/v1/openAlgoOrders. */
export async function getOpenAlgoOrders(
  symbol?: string,
): Promise<Array<{ algoId: number; symbol: string }>> {
  const rows = await binance.signedGet<Array<{ algoId: number; symbol: string }>>(
    "/fapi/v1/openAlgoOrders",
    symbol ? { symbol } : {},
  );
  return Array.isArray(rows) ? rows : [];
}

/**
 * The most recent fill for a symbol (used to recover the exit price when the
 * exchange closes a position via the protective stop between ticks).
 */
export async function lastFill(symbol: string): Promise<OrderFill | null> {
  const trades = await binance.signedGet<RawUserTrade[]>("/fapi/v1/userTrades", {
    symbol,
    limit: 1,
  });
  const t = trades[trades.length - 1];
  if (!t) return null;
  return {
    orderId: t.orderId,
    price: Number(t.price),
    qty: Number(t.qty),
    commission: t.commissionAsset === "USDT" ? Number(t.commission) : 0,
  };
}
