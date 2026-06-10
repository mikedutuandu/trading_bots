import type { Candle } from "../types.js";
import { getDb } from "./db.js";

/** Bulk upsert candles. Idempotent on (symbol, interval, open_time). */
export function saveCandles(candles: Candle[]): number {
  if (candles.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO candles (symbol, interval, open_time, open, high, low, close, volume, close_time)
     VALUES (@symbol, @interval, @openTime, @open, @high, @low, @close, @volume, @closeTime)
     ON CONFLICT(symbol, interval, open_time) DO UPDATE SET
       open=excluded.open, high=excluded.high, low=excluded.low,
       close=excluded.close, volume=excluded.volume, close_time=excluded.close_time`,
  );
  const insertMany = db.transaction((rows: Candle[]) => {
    for (const c of rows) stmt.run(c);
  });
  insertMany(candles);
  return candles.length;
}

interface CandleRow {
  symbol: string;
  interval: string;
  open_time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  close_time: number;
}

function rowToCandle(r: CandleRow): Candle {
  return {
    symbol: r.symbol,
    interval: r.interval,
    openTime: r.open_time,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
    closeTime: r.close_time,
  };
}

export function getCandles(
  symbol: string,
  interval: string,
  opts: { from?: number; to?: number; limit?: number } = {},
): Candle[] {
  const db = getDb();
  const clauses = ["symbol = ?", "interval = ?"];
  const args: (string | number)[] = [symbol, interval];
  if (opts.from !== undefined) {
    clauses.push("open_time >= ?");
    args.push(opts.from);
  }
  if (opts.to !== undefined) {
    clauses.push("open_time <= ?");
    args.push(opts.to);
  }
  const limit = opts.limit ? `LIMIT ${opts.limit}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM candles WHERE ${clauses.join(" AND ")} ORDER BY open_time ASC ${limit}`,
    )
    .all(...args) as CandleRow[];
  return rows.map(rowToCandle);
}

/** Most recent stored open_time for a symbol/interval, or null if none. */
export function lastCandleTime(symbol: string, interval: string): number | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT MAX(open_time) AS t FROM candles WHERE symbol = ? AND interval = ?`,
    )
    .get(symbol, interval) as { t: number | null };
  return row.t ?? null;
}

/** Earliest stored open_time for a symbol/interval, or null if none. */
export function earliestCandleTime(symbol: string, interval: string): number | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT MIN(open_time) AS t FROM candles WHERE symbol = ? AND interval = ?`,
    )
    .get(symbol, interval) as { t: number | null };
  return row.t ?? null;
}

export function candleCount(symbol: string, interval: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM candles WHERE symbol = ? AND interval = ?`)
    .get(symbol, interval) as { n: number };
  return row.n;
}

/** Every symbol that has candles stored for `interval` (the research-DB universe). */
export function distinctSymbols(interval: string): string[] {
  const rows = getDb()
    .prepare(`SELECT DISTINCT symbol FROM candles WHERE interval = ? ORDER BY symbol`)
    .all(interval) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}
