import { logger } from "../logger.js";
import { getDb, closeDb } from "../storage/db.js";
import { backupDb } from "../engine/backup.js";

/**
 * Manual one-off SQLite backup → data/backups/binance-<timestamp>.sqlite.
 *   npm run backup
 */
async function main(): Promise<void> {
  getDb();
  await backupDb();
  closeDb();
}

main().catch((err) => {
  logger.error("backup failed:", err);
  process.exit(1);
});
