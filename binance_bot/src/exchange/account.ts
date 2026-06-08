import type { Side } from "../types.js";
import { logger } from "../logger.js";
import { binance, isBinanceCode } from "./binance.js";

/**
 * Signed account/position reads + per-symbol setup (leverage, margin type).
 * USDT-M Futures `fapi`. Requires BINANCE_API_KEY / BINANCE_API_SECRET.
 */

interface RawAccount {
  totalWalletBalance: string;
  totalMarginBalance: string; // wallet + unrealized PnL
  totalUnrealizedProfit: string;
  availableBalance: string;
}

interface RawPositionRisk {
  symbol: string;
  positionAmt: string; // signed: + long, - short
  entryPrice: string;
  unRealizedProfit: string;
  leverage: string;
}

export interface AccountEquity {
  /** wallet + unrealized PnL — the value we size new risk against. */
  equity: number;
  walletBalance: number;
  available: number;
  unrealized: number;
}

export async function getAccountEquity(): Promise<AccountEquity> {
  const a = await binance.signedGet<RawAccount>("/fapi/v2/account");
  return {
    equity: Number(a.totalMarginBalance),
    walletBalance: Number(a.totalWalletBalance),
    available: Number(a.availableBalance),
    unrealized: Number(a.totalUnrealizedProfit),
  };
}

export interface ExchangePosition {
  symbol: string;
  /** signed net quantity: positive = long, negative = short, 0 = flat. */
  qty: number;
  entry: number;
  side: Side | null;
  unrealized: number;
}

function toPosition(r: RawPositionRisk): ExchangePosition {
  const qty = Number(r.positionAmt);
  return {
    symbol: r.symbol,
    qty,
    entry: Number(r.entryPrice),
    side: qty > 0 ? "long" : qty < 0 ? "short" : null,
    unrealized: Number(r.unRealizedProfit),
  };
}

/** One-line description of an exchange position for logs. */
export function formatPosition(p: ExchangePosition): string {
  return `${p.symbol} ${p.side} qty=${p.qty} entry=${p.entry} uPnL=${p.unrealized.toFixed(2)}`;
}

/** Net position for one symbol (source of truth for reconciliation). */
export async function getPosition(symbol: string): Promise<ExchangePosition> {
  const rows = await binance.signedGet<RawPositionRisk[]>("/fapi/v2/positionRisk", {
    symbol,
  });
  const r = rows[0];
  if (!r) return { symbol, qty: 0, entry: 0, side: null, unrealized: 0 };
  return toPosition(r);
}

/** All non-flat positions on the account. */
export async function getOpenPositions(): Promise<ExchangePosition[]> {
  const rows = await binance.signedGet<RawPositionRisk[]>("/fapi/v2/positionRisk");
  return rows.map(toPosition).filter((p) => p.qty !== 0);
}

/** Set leverage for a symbol. Safe to call repeatedly. */
export async function setLeverage(symbol: string, leverage: number): Promise<void> {
  await binance.signedPost("/fapi/v1/leverage", { symbol, leverage });
}

/** True if the account is in hedge (dual-side) mode. The engine assumes one-way. */
export async function isHedgeMode(): Promise<boolean> {
  const r = await binance.signedGet<{ dualSidePosition: boolean }>("/fapi/v1/positionSide/dual");
  return r.dualSidePosition;
}

/** Switch the account to one-way position mode (no-op/ignored if already set). */
export async function setOneWayMode(): Promise<void> {
  try {
    await binance.signedPost("/fapi/v1/positionSide/dual", { dualSidePosition: "false" });
  } catch (err) {
    // -4059 = "No need to change position side" → already one-way.
    if (isBinanceCode(err, -4059)) return;
    throw err;
  }
}

/**
 * Set margin type (ISOLATED | CROSSED). Binance returns code -4046
 * ("No need to change margin type") when it's already set — treat as success.
 */
export async function setMarginType(
  symbol: string,
  marginType: "ISOLATED" | "CROSSED",
): Promise<void> {
  try {
    await binance.signedPost("/fapi/v1/marginType", { symbol, marginType });
  } catch (err) {
    // -4046 = "No need to change margin type" → already set.
    if (isBinanceCode(err, -4046)) {
      logger.debug(`${symbol} margin type already ${marginType}`);
      return;
    }
    throw err;
  }
}
