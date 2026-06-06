import type { Side, SymbolFilter } from "../types.js";
import { logger } from "../logger.js";
import { roundToStep, roundToTick } from "../risk/sizing.js";
import { binance, briefError, isBinanceCode } from "./binance.js";

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
/** Deterministic-ish client order id for idempotency / log correlation. */
function clientOrderId(tag: string, symbol: string): string {
  return `b3-${tag}-${symbol}-${Date.now()}-${seq++}`.slice(0, 36);
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

/**
 * Sum the userTrades for one order → precise average fill price + commission.
 * Commission is normalized to USDT; non-USDT commission (rare on futures) is left
 * as-is and logged, since it can't be converted without an extra price lookup.
 */
async function fillsForOrder(symbol: string, orderId: number): Promise<{ price: number; qty: number; commission: number }> {
  const trades = await binance.signedGet<RawUserTrade[]>("/fapi/v1/userTrades", {
    symbol,
    orderId,
  });
  let qty = 0;
  let quote = 0;
  let commission = 0;
  for (const t of trades) {
    const q = Number(t.qty);
    qty += q;
    quote += q * Number(t.price);
    if (t.commissionAsset === "USDT") commission += Number(t.commission);
    else logger.warn(`${symbol} order ${orderId} commission in ${t.commissionAsset}, not counted`);
  }
  return { price: qty > 0 ? quote / qty : 0, qty, commission };
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

  const order = await binance.signedPost<RawOrder>("/fapi/v1/order", {
    symbol,
    side: orderSide(tradeSide, opts.reduceOnly ?? false),
    type: "MARKET",
    quantity: rounded,
    reduceOnly: opts.reduceOnly ? "true" : undefined,
    newClientOrderId: clientOrderId(opts.tag ?? "mkt", symbol),
    newOrderRespType: "RESULT",
  });

  // Prefer precise fills from userTrades; fall back to the order response.
  let price = Number(order.avgPrice);
  let filled = Number(order.executedQty);
  let commission = 0;
  try {
    const f = await fillsForOrder(symbol, order.orderId);
    if (f.qty > 0) {
      price = f.price;
      filled = f.qty;
    }
    commission = f.commission;
  } catch (err) {
    logger.warn(`${symbol} could not read userTrades for order ${order.orderId}:`, err);
  }
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
