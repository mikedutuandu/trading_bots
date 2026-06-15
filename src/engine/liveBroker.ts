import type { Side, SymbolFilter } from "../types.js";
import { logger } from "../logger.js";
import { getAccountEquity, getPosition, setLeverage } from "../exchange/account.js";
import { briefError, isBinanceCode } from "../exchange/binance.js";
import {
  cancelAlgoOrder,
  getOpenAlgoOrders,
  placeMarketOrder,
  placeProtectiveStop,
} from "../exchange/orders.js";
import type { Broker, BrokerPosition, ExecResult } from "./broker.js";

/**
 * Real Binance USDT-M Futures broker. Mainnet use is gated by the ALLOW_LIVE +
 * CONFIRM_LIVE checks in run.ts. Executes the engine's decisions as real orders:
 * market entries, reduceOnly market exits, and a `closePosition` STOP_MARKET
 * safety net that protects the position if the bot is offline between candles.
 */
export class LiveBroker implements Broker {
  readonly kind = "live" as const;
  private readonly prepared = new Set<string>();

  constructor(private readonly filters: Map<string, SymbolFilter>) {}

  private filter(symbol: string): SymbolFilter {
    const f = this.filters.get(symbol);
    if (!f) throw new Error(`No exchangeInfo filter for ${symbol}`);
    return f;
  }

  async prepareSymbol(symbol: string, leverage: number): Promise<void> {
    if (this.prepared.has(symbol)) return;
    await setLeverage(symbol, leverage);
    // Margin type is left at the account default (CROSSED) to avoid -4046 churn;
    // it can be set explicitly per symbol later if isolated margin is desired.
    this.prepared.add(symbol);
    logger.debug(`prepared ${symbol} @ ${leverage}x`);
  }

  async getEquity(): Promise<number> {
    return (await getAccountEquity()).equity;
  }

  async getPosition(symbol: string): Promise<BrokerPosition> {
    const p = await getPosition(symbol);
    return { symbol, qty: p.qty, entry: p.entry, side: p.side };
  }

  async marketOpen(symbol: string, side: Side, qty: number): Promise<ExecResult> {
    const fill = await placeMarketOrder(symbol, side, qty, this.filter(symbol), { tag: "open" });
    return { price: fill.price, qty: fill.qty, commission: fill.commission };
  }

  async marketReduce(symbol: string, side: Side, qty: number): Promise<ExecResult> {
    const fill = await placeMarketOrder(symbol, side, qty, this.filter(symbol), {
      reduceOnly: true,
      tag: "reduce",
    });
    return { price: fill.price, qty: fill.qty, commission: fill.commission };
  }

  async setProtectiveStop(
    symbol: string,
    side: Side,
    stopPrice: number,
    prevStopId: string | null,
  ): Promise<string | null> {
    if (prevStopId) await cancelAlgoOrder(symbol, prevStopId);
    const place = async () => String(await placeProtectiveStop(symbol, side, stopPrice, this.filter(symbol)));
    // Best-effort: a venue that rejects the stop (or a transient API error) must
    // degrade to bot-managed candle-close stops, never throw into the engine/startup.
    try {
      return await place();
    } catch (err) {
      // -4130 = a closePosition stop already exists in this direction. An ORPHANED stop
      // (e.g. left by a duplicate entry) that prevStopId didn't reference blocks every
      // replace forever, freezing the stop at its old level. Clear ALL the symbol's algo
      // stops once, then retry — this is what unsticks a breakeven/trail move.
      if (isBinanceCode(err, -4130)) {
        try {
          for (const o of await getOpenAlgoOrders(symbol)) await cancelAlgoOrder(symbol, o.algoId);
          return await place();
        } catch (e2) {
          logger.warn(`${symbol}: protective stop not placed after clearing orphans (${briefError(e2)}); managing on candle close`);
          return null;
        }
      }
      logger.warn(`${symbol}: protective stop not placed (${briefError(err)}); managing on candle close instead`);
      return null;
    }
  }

  async clearProtectiveStop(symbol: string, stopId: string | null): Promise<void> {
    if (stopId) await cancelAlgoOrder(symbol, stopId);
  }

  async settleFunding(): Promise<void> {
    /* the exchange already charged funding to the real balance */
  }
}
