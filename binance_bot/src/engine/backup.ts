import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { dayKey } from "../util.js";
import { getDb } from "../storage/db.js";
import { getMeta, setMeta } from "../storage/engineState.js";

/**
 * Consistent SQLite backups via the online-backup API (safe on a live WAL DB).
 * The engine calls maybeBackup() each tick → at most one snapshot per UTC day.
 */

const BACKUP_DAY_KEY = "backup:lastDay";

export async function backupDb(tag?: string): Promise<string> {
  mkdirSync(config.ops.backupDir, { recursive: true });
  const stamp = (tag ?? new Date().toISOString()).replace(/[:.]/g, "-");
  // Name backups after the source DB (testnet.sqlite → testnet-…) so venues don't collide.
  const src = basename(config.storage.dbPath).replace(/\.sqlite$/, "");
  const dest = `${config.ops.backupDir}/${src}-${stamp}.sqlite`;
  await getDb().backup(dest);
  logger.info(`db backed up → ${dest}`);
  return dest;
}

/** Back up at most once per UTC day. Fire-and-forget; never blocks the tick. */
export function maybeBackup(tickTime: number): void {
  const day = dayKey(tickTime);
  if (getMeta(BACKUP_DAY_KEY) === day) return;
  setMeta(BACKUP_DAY_KEY, day);
  backupDb(day).catch((err) => logger.warn("daily backup failed:", err));
}
