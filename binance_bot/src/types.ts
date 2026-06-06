// ─── Market data ────────────────────────────────────────────────────────────

export interface Candle {
  symbol: string;
  interval: string;
  openTime: number; // ms epoch of candle open
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number; // ms epoch of candle close
}

/** Per-symbol trading rules from exchangeInfo (used to round orders). */
export interface SymbolFilter {
  symbol: string;
  tickSize: number; // price increment
  stepSize: number; // quantity increment
  minQty: number;
  minNotional: number; // min order value in USDT
  pricePrecision: number;
  quantityPrecision: number;
}

// ─── Strategy ────────────────────────────────────────────────────────────────

export type Side = "long" | "short";

export type PlaybookName =
  | "trend-pullback"
  | "trend-breakout"
  | "volatility"
  | "intraday";

/** A proposed trade emitted by a playbook (before sizing). */
export interface Signal {
  symbol: string;
  side: Side;
  playbook: PlaybookName;
  setup: string; // e.g. "pullback", "retest"
  timeframe: string;
  entry: number; // intended entry price (close of trigger candle)
  stop: number; // initial stop-loss price
  tp1: number;
  tp2: number;
  tp3: number;
  reason?: string; // human-readable why
}

// ─── Trades ──────────────────────────────────────────────────────────────────

export type TradeStatus = "OPEN" | "CLOSED";

export type CloseReason =
  | "STOP" // initial stop hit (full -1R loss)
  | "MANAGED_STOP" // trailing/breakeven stop after partial TP
  | "HEALTH_CLOSE" // trend invalidation or time-stop
  | "TP3"; // ran to final target

/** A sized, executable/executed trade — the unit stored in the journal. */
export interface Trade {
  id: string;
  symbol: string;
  side: Side;
  playbook: PlaybookName;
  setup: string;
  timeframe: string;

  entryPrice: number;
  stopPrice: number;
  qty: number;
  notional: number;
  leverage: number;
  riskUsdt: number; // 1R in USDT
  rPlanned: number; // planned reward in R at full target (e.g. 3)

  tp1: number;
  tp2: number;
  tp3: number;

  status: TradeStatus;
  exitPrice?: number;
  closeReason?: CloseReason;
  rRealized?: number;
  grossPnl?: number;
  commission?: number;
  funding?: number;
  netPnl?: number;

  openedAt: number; // ms epoch
  closedAt?: number; // ms epoch
}

export interface EquitySnapshot {
  ts: number;
  equity: number;
  available: number;
  marginUsed: number;
  openPositions: number;
}
