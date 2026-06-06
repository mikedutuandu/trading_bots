import { config } from "../config.js";
import { logger } from "../logger.js";
import { binance } from "../exchange/binance.js";
import { getKlines, getUniverse } from "../exchange/marketData.js";
import {
  candleCount,
  earliestCandleTime,
  lastCandleTime,
  saveCandles,
} from "../storage/candles.js";
import { closeDb } from "../storage/db.js";

/**
 * Download and cache 1h history for the trading universe into SQLite.
 * Idempotent: resumes from the last stored candle per symbol.
 *
 * Usage:
 *   npm run collect              # ~18 months of history, top-50 universe
 *   DAYS=730 npm run collect     # override history depth
 */

const DAYS = Number(process.env.DAYS ?? 540); // ~18 months default
const interval = config.strategy.timeframe;

async function main(): Promise<void> {
  await binance.syncTime();
  const symbols = await getUniverse();
  logger.info(`collecting ${interval} candles for ${symbols.length} symbols (${DAYS}d)`);

  const defaultStart = Date.now() - DAYS * 24 * 60 * 60 * 1000;
  let totalSaved = 0;

  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    const earliest = earliestCandleTime(symbol, interval);
    const last = lastCandleTime(symbol, interval);

    try {
      let saved = 0;
      // Backfill older history if we don't reach back to defaultStart yet.
      if (earliest === null) {
        saved += saveCandles(await getKlines(symbol, interval, { startTime: defaultStart }));
      } else {
        if (defaultStart < earliest) {
          saved += saveCandles(
            await getKlines(symbol, interval, { startTime: defaultStart, endTime: earliest }),
          );
        }
        // Extend forward from the latest stored candle.
        if (last !== null) {
          saved += saveCandles(await getKlines(symbol, interval, { startTime: last + 1 }));
        }
      }
      totalSaved += saved;
      logger.info(
        `[${i + 1}/${symbols.length}] ${symbol}: +${saved} candles ` +
          `(total ${candleCount(symbol, interval)}, weight ${binance.getUsedWeight()})`,
      );
    } catch (err) {
      logger.error(`failed to collect ${symbol}:`, err);
    }
  }

  logger.info(`done. saved ${totalSaved} candles across ${symbols.length} symbols`);
  closeDb();
}

main().catch((err) => {
  logger.error("collect failed:", err);
  process.exit(1);
});
