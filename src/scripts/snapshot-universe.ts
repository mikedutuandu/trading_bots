import { logger } from "../logger.js";
import { binance } from "../exchange/binance.js";
import { getUniverse } from "../exchange/marketData.js";
import { getDb, closeDb } from "../storage/db.js";

/**
 * Freeze the current dynamic universe into a fixed, reproducible list.
 * Stored in universe_snapshots and printed as a SYMBOLS= line you can paste
 * into .env to pin backtests to a stable set.
 */
async function main(): Promise<void> {
  await binance.syncTime();
  const symbols = await getUniverse();
  const ts = Date.now();

  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO universe_snapshots (ts, symbol, rank) VALUES (?, ?, ?)`,
  );
  const insert = db.transaction(() => {
    symbols.forEach((s, i) => stmt.run(ts, s, i + 1));
  });
  insert();

  logger.info(`snapshot of ${symbols.length} symbols saved at ${new Date(ts).toISOString()}`);
  console.log(`\nSYMBOLS=${symbols.join(",")}\n`);
  closeDb();
}

main().catch((err) => {
  logger.error("snapshot failed:", err);
  process.exit(1);
});
