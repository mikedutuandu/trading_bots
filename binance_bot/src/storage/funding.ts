import { getDb } from "./db.js";

/** A single funding settlement: rate applied to notional at `fundingTime`. */
export interface FundingRate {
  symbol: string;
  fundingTime: number; // ms epoch of the 8h settlement
  rate: number; // signed fraction; long pays when rate>0
}

/** Bulk upsert funding rates. Idempotent on (symbol, funding_time). */
export function saveFundingRates(rows: FundingRate[]): number {
  if (rows.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO funding_rates (symbol, funding_time, rate)
     VALUES (@symbol, @fundingTime, @rate)
     ON CONFLICT(symbol, funding_time) DO UPDATE SET rate=excluded.rate`,
  );
  const insertMany = db.transaction((batch: FundingRate[]) => {
    for (const r of batch) stmt.run(r);
  });
  insertMany(rows);
  return rows.length;
}

interface FundingRow {
  symbol: string;
  funding_time: number;
  rate: number;
}

/**
 * Load funding settlements for a symbol in ascending time order.
 * Returns parallel arrays for cheap binary-search lookups in the backtest hot loop.
 */
export function getFundingRates(
  symbol: string,
  opts: { from?: number; to?: number } = {},
): { times: number[]; rates: number[] } {
  const db = getDb();
  const clauses = ["symbol = ?"];
  const args: (string | number)[] = [symbol];
  if (opts.from !== undefined) {
    clauses.push("funding_time >= ?");
    args.push(opts.from);
  }
  if (opts.to !== undefined) {
    clauses.push("funding_time <= ?");
    args.push(opts.to);
  }
  const rows = db
    .prepare(
      `SELECT symbol, funding_time, rate FROM funding_rates
       WHERE ${clauses.join(" AND ")} ORDER BY funding_time ASC`,
    )
    .all(...args) as FundingRow[];
  const times: number[] = [];
  const rates: number[] = [];
  for (const r of rows) {
    times.push(r.funding_time);
    rates.push(r.rate);
  }
  return { times, rates };
}

/** Most recent stored funding_time for a symbol, or null if none. */
export function lastFundingTime(symbol: string): number | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT MAX(funding_time) AS t FROM funding_rates WHERE symbol = ?`)
    .get(symbol) as { t: number | null };
  return row.t ?? null;
}

/** Earliest stored funding_time for a symbol, or null if none. */
export function earliestFundingTime(symbol: string): number | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT MIN(funding_time) AS t FROM funding_rates WHERE symbol = ?`)
    .get(symbol) as { t: number | null };
  return row.t ?? null;
}

export function fundingCount(symbol: string): number {
  const db = getDb();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM funding_rates WHERE symbol = ?`)
    .get(symbol) as { n: number };
  return row.n;
}
