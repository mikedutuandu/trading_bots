import Database from "better-sqlite3";
import { logger } from "../logger.js";

/**
 * Print the cross-sectional paper-tracker's accumulating forward track record.
 *   tsx src/scripts/xsmom-status.ts
 */
const PAPER_DB = process.env.XSMOM_DB ?? "./data/xsmom-paper.sqlite";

function main(): void {
  const db = new Database(PAPER_DB, { readonly: true, fileMustExist: true });
  const meta = (k: string) => (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(k) as { value: string } | undefined)?.value;
  const equity = Number(meta("equity") ?? "1");
  const params = meta("params") ?? "{}";
  const periods = db.prepare(`SELECT ts, ret, fund, equity, longs, shorts FROM periods ORDER BY ts ASC`).all() as Array<{
    ts: number; ret: number; fund: number; equity: number; longs: string; shorts: string;
  }>;

  logger.info(`params ${params} | equity ${equity.toFixed(4)} (${((equity - 1) * 100).toFixed(2)}%) | ${periods.length} realized periods`);
  if (periods.length > 0) {
    const wins = periods.filter((p) => p.ret > 0).length;
    const totFund = periods.reduce((a, p) => a + p.fund, 0);
    const mean = periods.reduce((a, p) => a + p.ret, 0) / periods.length;
    const std = Math.sqrt(Math.max(0, periods.reduce((a, p) => a + p.ret * p.ret, 0) / periods.length - mean * mean));
    logger.info(`win rate ${((wins / periods.length) * 100).toFixed(0)}% | mean ${(mean * 100).toFixed(3)}%/period | per-period Sharpe ${std > 0 ? (mean / std).toFixed(2) : "n/a"} | total funding ${(totFund * 100).toFixed(2)}%`);
    logger.info(`recent periods (most recent last):`);
    for (const p of periods.slice(-10)) {
      logger.info(`  ${new Date(p.ts).toISOString().slice(0, 16)}  ret ${(p.ret * 100).toFixed(2).padStart(6)}%  fund ${(p.fund * 100).toFixed(2).padStart(6)}%  eq ${p.equity.toFixed(4)}`);
    }
  } else {
    logger.info(`no realized periods yet — the first book is open; check back after H hours.`);
  }
  // Current open book.
  const book = db.prepare(`SELECT symbol, weight FROM book ORDER BY weight DESC`).all() as Array<{ symbol: string; weight: number }>;
  if (book.length > 0) {
    logger.info(`open book: LONG ${book.filter((b) => b.weight > 0).map((b) => b.symbol).join(",")} | SHORT ${book.filter((b) => b.weight < 0).map((b) => b.symbol).join(",")}`);
  }
  db.close();
}

main();
