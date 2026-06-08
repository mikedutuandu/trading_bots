import type { Trade } from "../types.js";
import { getDb } from "./db.js";

interface TradeRow {
  id: string;
  symbol: string;
  side: string;
  playbook: string;
  setup: string;
  timeframe: string;
  entry_price: number;
  stop_price: number;
  qty: number;
  notional: number;
  leverage: number;
  risk_usdt: number;
  r_planned: number;
  tp1: number;
  tp2: number;
  tp3: number;
  status: string;
  exit_price: number | null;
  close_reason: string | null;
  r_realized: number | null;
  gross_pnl: number | null;
  commission: number | null;
  funding: number | null;
  net_pnl: number | null;
  opened_at: number;
  closed_at: number | null;
}

export function saveTrade(t: Trade): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO trades (
      id, symbol, side, playbook, setup, timeframe,
      entry_price, stop_price, qty, notional, leverage, risk_usdt, r_planned,
      tp1, tp2, tp3, status,
      exit_price, close_reason, r_realized, gross_pnl, commission, funding, net_pnl,
      opened_at, closed_at
    ) VALUES (
      @id, @symbol, @side, @playbook, @setup, @timeframe,
      @entryPrice, @stopPrice, @qty, @notional, @leverage, @riskUsdt, @rPlanned,
      @tp1, @tp2, @tp3, @status,
      @exitPrice, @closeReason, @rRealized, @grossPnl, @commission, @funding, @netPnl,
      @openedAt, @closedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status, exit_price=excluded.exit_price,
      close_reason=excluded.close_reason, r_realized=excluded.r_realized,
      gross_pnl=excluded.gross_pnl, commission=excluded.commission,
      funding=excluded.funding, net_pnl=excluded.net_pnl, closed_at=excluded.closed_at`,
  ).run({
    ...t,
    exitPrice: t.exitPrice ?? null,
    closeReason: t.closeReason ?? null,
    rRealized: t.rRealized ?? null,
    grossPnl: t.grossPnl ?? null,
    commission: t.commission ?? null,
    funding: t.funding ?? null,
    netPnl: t.netPnl ?? null,
    closedAt: t.closedAt ?? null,
  });
}

function rowToTrade(r: TradeRow): Trade {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side as Trade["side"],
    playbook: r.playbook as Trade["playbook"],
    setup: r.setup,
    timeframe: r.timeframe,
    entryPrice: r.entry_price,
    stopPrice: r.stop_price,
    qty: r.qty,
    notional: r.notional,
    leverage: r.leverage,
    riskUsdt: r.risk_usdt,
    rPlanned: r.r_planned,
    tp1: r.tp1,
    tp2: r.tp2,
    tp3: r.tp3,
    status: r.status as Trade["status"],
    exitPrice: r.exit_price ?? undefined,
    closeReason: (r.close_reason as Trade["closeReason"]) ?? undefined,
    rRealized: r.r_realized ?? undefined,
    grossPnl: r.gross_pnl ?? undefined,
    commission: r.commission ?? undefined,
    funding: r.funding ?? undefined,
    netPnl: r.net_pnl ?? undefined,
    openedAt: r.opened_at,
    closedAt: r.closed_at ?? undefined,
  };
}

export function getOpenTrades(): Trade[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM trades WHERE status = 'OPEN' ORDER BY opened_at ASC`)
    .all() as TradeRow[];
  return rows.map(rowToTrade);
}

export function getClosedTrades(): Trade[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM trades WHERE status = 'CLOSED' ORDER BY closed_at ASC`)
    .all() as TradeRow[];
  return rows.map(rowToTrade);
}

/** CLOSED trades that closed at/after `sinceMs` — avoids loading the full (unbounded)
 *  history just to compute a recent slice (e.g. today's). */
export function getClosedSince(sinceMs: number): Trade[] {
  const rows = getDb()
    .prepare(`SELECT * FROM trades WHERE status = 'CLOSED' AND closed_at >= ? ORDER BY closed_at ASC`)
    .all(sinceMs) as TradeRow[];
  return rows.map(rowToTrade);
}

/** Most recent close time for a symbol (drives the per-symbol entry cooldown). */
export function lastCloseTime(symbol: string): number | null {
  const row = getDb()
    .prepare(
      `SELECT MAX(closed_at) AS t FROM trades WHERE symbol = ? AND status = 'CLOSED'`,
    )
    .get(symbol) as { t: number | null };
  return row.t ?? null;
}
