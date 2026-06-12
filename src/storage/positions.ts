import type { PlaybookName } from "../types.js";
import type { RuntimePosition } from "../risk/manage.js";
import { getDb } from "./db.js";

/**
 * An open position as the live/paper engine tracks it: the mutable runtime state
 * (`pos`, shared with the backtest's `manageOnCandle`) plus the journaling and
 * reconciliation metadata. Persisted so a restart can recover and reconcile
 * against the exchange rather than re-opening or orphaning trades.
 */
export interface EnginePosition {
  tradeId: string;
  symbol: string;
  playbook: PlaybookName;
  setup: string;
  pos: RuntimePosition;
  notional: number;
  riskUsdt: number;
  rPlanned: number;
  grossPnl: number;
  commission: number;
  funding: number;
  protectiveStopId: string | null;
  openedAt: number; // ms epoch of entry
  openedAtBarTime: number; // openTime of the entry candle (for elapsed-bar time-stop)
}

interface PositionRow {
  symbol: string;
  trade_id: string;
  side: string;
  playbook: string;
  setup: string;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  tp3: number;
  qty_total: number;
  qty_remaining: number;
  qty_tp1: number;
  qty_tp2: number;
  tp1_hit: number;
  tp2_hit: number;
  trail_active: number;
  trail_extreme: number;
  risk_usdt: number;
  notional: number;
  r_planned: number;
  gross_pnl: number;
  commission: number;
  funding: number;
  protective_stop_id: string | null;
  opened_at: number;
  opened_at_bar_time: number;
}

export function savePosition(p: EnginePosition): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO live_positions (
      symbol, trade_id, side, playbook, setup,
      entry, stop, tp1, tp2, tp3,
      qty_total, qty_remaining, qty_tp1, qty_tp2,
      tp1_hit, tp2_hit, trail_active, trail_extreme,
      risk_usdt, notional, r_planned, gross_pnl, commission, funding,
      protective_stop_id, opened_at, opened_at_bar_time
    ) VALUES (
      @symbol, @tradeId, @side, @playbook, @setup,
      @entry, @stop, @tp1, @tp2, @tp3,
      @qtyTotal, @qtyRemaining, @qtyTp1, @qtyTp2,
      @tp1Hit, @tp2Hit, @trailActive, @trailExtreme,
      @riskUsdt, @notional, @rPlanned, @grossPnl, @commission, @funding,
      @protectiveStopId, @openedAt, @openedAtBarTime
    )
    ON CONFLICT(symbol) DO UPDATE SET
      trade_id=excluded.trade_id, side=excluded.side, playbook=excluded.playbook,
      setup=excluded.setup, entry=excluded.entry, stop=excluded.stop,
      tp1=excluded.tp1, tp2=excluded.tp2, tp3=excluded.tp3,
      qty_total=excluded.qty_total, qty_remaining=excluded.qty_remaining,
      qty_tp1=excluded.qty_tp1, qty_tp2=excluded.qty_tp2,
      tp1_hit=excluded.tp1_hit, tp2_hit=excluded.tp2_hit,
      trail_active=excluded.trail_active, trail_extreme=excluded.trail_extreme,
      risk_usdt=excluded.risk_usdt, notional=excluded.notional,
      r_planned=excluded.r_planned, gross_pnl=excluded.gross_pnl,
      commission=excluded.commission, funding=excluded.funding,
      protective_stop_id=excluded.protective_stop_id,
      opened_at=excluded.opened_at, opened_at_bar_time=excluded.opened_at_bar_time`,
  ).run({
    symbol: p.symbol,
    tradeId: p.tradeId,
    side: p.pos.side,
    playbook: p.playbook,
    setup: p.setup,
    entry: p.pos.entry,
    stop: p.pos.stop,
    tp1: p.pos.tp1,
    tp2: p.pos.tp2,
    tp3: p.pos.tp3,
    qtyTotal: p.pos.qtyTotal,
    qtyRemaining: p.pos.qtyRemaining,
    qtyTp1: p.pos.qtyTp1,
    qtyTp2: p.pos.qtyTp2,
    tp1Hit: p.pos.tp1Hit ? 1 : 0,
    tp2Hit: p.pos.tp2Hit ? 1 : 0,
    trailActive: p.pos.trailActive ? 1 : 0,
    trailExtreme: p.pos.trailExtreme,
    riskUsdt: p.riskUsdt,
    notional: p.notional,
    rPlanned: p.rPlanned,
    grossPnl: p.grossPnl,
    commission: p.commission,
    funding: p.funding,
    protectiveStopId: p.protectiveStopId,
    openedAt: p.openedAt,
    openedAtBarTime: p.openedAtBarTime,
  });
}

function rowToPosition(r: PositionRow): EnginePosition {
  const pos: RuntimePosition = {
    side: r.side as RuntimePosition["side"],
    entry: r.entry,
    stop: r.stop,
    tp1: r.tp1,
    tp2: r.tp2,
    tp3: r.tp3,
    qtyTotal: r.qty_total,
    qtyRemaining: r.qty_remaining,
    qtyTp1: r.qty_tp1,
    qtyTp2: r.qty_tp2,
    tp1Hit: r.tp1_hit === 1,
    tp2Hit: r.tp2_hit === 1,
    trailActive: r.trail_active === 1,
    trailExtreme: r.trail_extreme,
    openedAtBar: 0, // bar index is recomputed from elapsed candles at runtime
  };
  return {
    tradeId: r.trade_id,
    symbol: r.symbol,
    playbook: r.playbook as PlaybookName,
    setup: r.setup,
    pos,
    notional: r.notional,
    riskUsdt: r.risk_usdt,
    rPlanned: r.r_planned,
    grossPnl: r.gross_pnl,
    commission: r.commission,
    funding: r.funding,
    protectiveStopId: r.protective_stop_id,
    openedAt: r.opened_at,
    openedAtBarTime: r.opened_at_bar_time,
  };
}

export function loadPositions(): EnginePosition[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM live_positions ORDER BY opened_at ASC`)
    .all() as PositionRow[];
  return rows.map(rowToPosition);
}

export function deletePosition(symbol: string): void {
  getDb().prepare(`DELETE FROM live_positions WHERE symbol = ?`).run(symbol);
}
