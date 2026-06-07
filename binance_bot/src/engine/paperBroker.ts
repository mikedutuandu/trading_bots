import { config } from "../config.js";
import type { Side } from "../types.js";
import type { Broker, BrokerPosition, ExecResult } from "./broker.js";

/**
 * Simulated broker: forward-tests the strategy on LIVE data with zero risk and no
 * API keys. Fills at the engine's intended price ± slippage and charges the taker
 * fee — the exact cost model the backtest uses — so paper PnL is directly
 * comparable to the backtest. Equity, positions and funding are tracked in-memory
 * (and the engine journals trades to SQLite as usual).
 */
export class PaperBroker implements Broker {
  readonly kind = "paper" as const;
  private equity: number;
  private readonly positions = new Map<string, { qty: number; entry: number; side: Side }>();
  private readonly takerFee = config.risk.takerFee;
  private readonly slip = config.risk.slippageBps / 10_000;

  constructor(startEquity: number) {
    this.equity = startEquity;
  }

  async prepareSymbol(): Promise<void> {
    /* no-op for paper */
  }

  async getEquity(): Promise<number> {
    return this.equity;
  }

  async getPosition(symbol: string): Promise<BrokerPosition> {
    const p = this.positions.get(symbol);
    if (!p) return { symbol, qty: 0, entry: 0, side: null };
    return { symbol, qty: p.side === "long" ? p.qty : -p.qty, entry: p.entry, side: p.side };
  }

  async marketOpen(symbol: string, side: Side, qty: number, priceHint: number): Promise<ExecResult> {
    const price = side === "long" ? priceHint * (1 + this.slip) : priceHint * (1 - this.slip);
    const commission = priceHint * qty * this.takerFee;
    this.equity -= commission;
    this.positions.set(symbol, { qty, entry: price, side });
    return { price, qty, commission };
  }

  async marketReduce(symbol: string, side: Side, qty: number, priceHint: number): Promise<ExecResult> {
    const price = side === "long" ? priceHint * (1 - this.slip) : priceHint * (1 + this.slip);
    const p = this.positions.get(symbol);
    // Never reduce more than the open qty — mirrors live reduceOnly, so a stale or
    // oversized tranche can't over-reduce into a negative position and corrupt equity.
    const fillQty = p ? Math.min(qty, p.qty) : qty;
    const commission = priceHint * fillQty * this.takerFee;
    let realized = 0;
    if (p) {
      realized = side === "long" ? (price - p.entry) * fillQty : (p.entry - price) * fillQty;
      p.qty -= fillQty;
      if (p.qty <= 1e-9) this.positions.delete(symbol);
    }
    this.equity += realized - commission;
    return { price, qty: fillQty, commission };
  }

  async setProtectiveStop(): Promise<string | null> {
    return null; // paper has no resting stop; the engine's candle-close manage handles it
  }

  async clearProtectiveStop(): Promise<void> {
    /* no-op for paper */
  }

  async settleFunding(cashflow: number): Promise<void> {
    this.equity += cashflow;
  }
}
