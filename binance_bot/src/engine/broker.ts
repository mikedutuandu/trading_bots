import type { Side } from "../types.js";

/** The realized result of a market execution. */
export interface ExecResult {
  price: number; // average fill price (effective; paper applies slippage here)
  qty: number; // filled quantity (absolute)
  commission: number; // USDT commission charged
}

/** Net position as the broker sees it (exchange truth for live, sim for paper). */
export interface BrokerPosition {
  symbol: string;
  qty: number; // signed: + long, - short, 0 flat
  entry: number; // average entry price (0 if flat)
  side: Side | null;
}

/**
 * Execution boundary shared by the backtest-faithful engine. The engine makes all
 * the *decisions* (using the same `manageOnCandle` / `sizePosition` / playbook code
 * as the backtest); the broker only *executes* them — simulated (paper) or real
 * (live on Binance testnet/demo). Swapping brokers must not change engine logic.
 */
export interface Broker {
  readonly kind: "paper" | "live";

  /** One-time per-symbol prep (leverage, margin type). No-op for paper. */
  prepareSymbol(symbol: string, leverage: number): Promise<void>;

  /** Account equity in USDT (wallet + unrealized). Drives risk sizing. */
  getEquity(): Promise<number>;

  /** Current net position for a symbol — the source of truth for reconciliation. */
  getPosition(symbol: string): Promise<BrokerPosition>;

  /** Open / add to a position with a market order. `priceHint` is the engine's
   *  intended price (used by paper for slippage; ignored by live market orders). */
  marketOpen(symbol: string, side: Side, qty: number, priceHint: number): Promise<ExecResult>;

  /** Reduce / close a position with a reduceOnly market order. */
  marketReduce(symbol: string, side: Side, qty: number, priceHint: number): Promise<ExecResult>;

  /** Place/replace a protective stop that closes the whole position if triggered.
   *  Cancels `prevStopId` first. BEST-EFFORT: never throws — returns the new order
   *  id, or null when not placed (paper, or a venue rejection → bot manages the
   *  stop on candle close instead). */
  setProtectiveStop(
    symbol: string,
    side: Side,
    stopPrice: number,
    prevStopId: string | null,
  ): Promise<string | null>;

  /** Cancel the protective stop (e.g. on full close). No-op for paper. */
  clearProtectiveStop(symbol: string, stopId: string | null): Promise<void>;

  /** Apply a funding cashflow to equity. Paper adjusts its sim balance; live
   *  no-ops because the exchange already charged it to the real balance. */
  settleFunding(cashflow: number): Promise<void>;
}
