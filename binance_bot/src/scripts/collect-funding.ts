import { config } from "../config.js";
import { logger } from "../logger.js";
import { binance } from "../exchange/binance.js";
import { getFundingHistory } from "../exchange/marketData.js";
import { getDb, closeDb } from "../storage/db.js";
import {
  earliestFundingTime,
  fundingCount,
  lastFundingTime,
  saveFundingRates,
} from "../storage/funding.js";

/**
 * Download and cache 8h funding-rate history for the symbols already in the DB,
 * over the same date span as the stored candles. Idempotent: backfills older
 * history and extends forward from the latest stored settlement.
 *
 * Usage:
 *   npm run collect-funding
 */

function dbSymbols(interval: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT DISTINCT symbol FROM candles WHERE interval = ? ORDER BY symbol`)
    .all(interval) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}

function candleSpan(interval: string): { from: number; to: number } {
  const db = getDb();
  const row = db
    .prepare(`SELECT MIN(open_time) AS mn, MAX(close_time) AS mx FROM candles WHERE interval = ?`)
    .get(interval) as { mn: number | null; mx: number | null };
  return { from: row.mn ?? Date.now(), to: row.mx ?? Date.now() };
}

async function main(): Promise<void> {
  await binance.syncTime();
  const interval = config.strategy.timeframe;
  const symbols = dbSymbols(interval);
  if (symbols.length === 0) throw new Error("No candles in DB. Run `npm run collect` first.");

  const span = candleSpan(interval);
  logger.info(
    `collecting funding for ${symbols.length} symbols ` +
      `(${new Date(span.from).toISOString()} → ${new Date(span.to).toISOString()})`,
  );

  let totalSaved = 0;
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    try {
      let saved = 0;
      const earliest = earliestFundingTime(symbol);
      const last = lastFundingTime(symbol);

      if (earliest === null) {
        saved += saveFundingRates(
          await getFundingHistory(symbol, { startTime: span.from, endTime: span.to }),
        );
      } else {
        // Backfill older history if needed.
        if (span.from < earliest) {
          saved += saveFundingRates(
            await getFundingHistory(symbol, { startTime: span.from, endTime: earliest }),
          );
        }
        // Extend forward from the latest stored settlement.
        if (last !== null) {
          saved += saveFundingRates(
            await getFundingHistory(symbol, { startTime: last + 1, endTime: span.to }),
          );
        }
      }
      totalSaved += saved;
      logger.info(
        `[${i + 1}/${symbols.length}] ${symbol}: +${saved} funding rows ` +
          `(total ${fundingCount(symbol)}, weight ${binance.getUsedWeight()})`,
      );
    } catch (err) {
      logger.error(`failed to collect funding for ${symbol}:`, err);
    }
  }

  logger.info(`done. saved ${totalSaved} funding rows across ${symbols.length} symbols`);
  closeDb();
}

main().catch((err) => {
  logger.error("collect-funding failed:", err);
  process.exit(1);
});
