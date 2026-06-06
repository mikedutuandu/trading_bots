import type { EquitySnapshot } from "../types.js";
import { dayStartMs } from "../util.js";
import { getDb } from "./db.js";

/** Record an equity snapshot (one per engine tick). Idempotent on ts. */
export function saveEquitySnapshot(s: EquitySnapshot): void {
  getDb()
    .prepare(
      `INSERT INTO equity_snapshots (ts, equity, available, margin_used, open_positions)
       VALUES (@ts, @equity, @available, @marginUsed, @openPositions)
       ON CONFLICT(ts) DO UPDATE SET
         equity=excluded.equity, available=excluded.available,
         margin_used=excluded.margin_used, open_positions=excluded.open_positions`,
    )
    .run(s);
}

/**
 * Equity at the start of the given UTC day (the earliest snapshot whose ts falls
 * on that day). Used by the daily-loss kill switch. Falls back to `current` when
 * no snapshot exists yet today.
 */
export function dayStartEquity(dayMs: number, current: number): number {
  const dayStart = dayStartMs(dayMs);
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const row = getDb()
    .prepare(
      `SELECT equity FROM equity_snapshots
       WHERE ts >= ? AND ts < ? ORDER BY ts ASC LIMIT 1`,
    )
    .get(dayStart, dayEnd) as { equity: number } | undefined;
  return row?.equity ?? current;
}

// ─── Generic key/value bookkeeping ───────────────────────────────────────────

export function getMeta(key: string): string | null {
  const row = getDb()
    .prepare(`SELECT value FROM engine_meta WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO engine_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(key, value);
}

export function getMetaNum(key: string): number | null {
  const v = getMeta(key);
  return v === null ? null : Number(v);
}

/** Equity curve (oldest→newest) for the dashboard, optionally capped to the last N points. */
export function getEquityCurve(limit?: number): Array<{ ts: number; equity: number; openPositions: number }> {
  const rows = getDb()
    .prepare(
      `SELECT ts, equity, open_positions FROM equity_snapshots ORDER BY ts ${limit ? "DESC" : "ASC"} ${limit ? `LIMIT ${limit}` : ""}`,
    )
    .all() as Array<{ ts: number; equity: number; open_positions: number }>;
  const mapped = rows.map((r) => ({ ts: r.ts, equity: r.equity, openPositions: r.open_positions }));
  return limit ? mapped.reverse() : mapped;
}
