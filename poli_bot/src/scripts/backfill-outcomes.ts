/**
 * Backfill polymarket_outcome_up for every window already in the DB.
 * Useful after introducing the new column or for re-verification.
 */
import Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchSettledOutcome } from "../polymarket/gamma.js";

interface Row {
  window_end_ts: number;
  market_slug: string;
  outcome_up: number | null;
  polymarket_outcome_up: number | null;
}

async function main(): Promise<void> {
  const db = new Database(config.collector.dbPath);
  // ensure column exists
  const cols = db.prepare(`PRAGMA table_info(window_outcomes)`).all() as { name: string }[];
  if (!cols.some((c) => c.name === "polymarket_outcome_up")) {
    db.exec(`ALTER TABLE window_outcomes ADD COLUMN polymarket_outcome_up INTEGER`);
  }
  const rows = db.prepare(`SELECT window_end_ts, market_slug, outcome_up, polymarket_outcome_up FROM window_outcomes ORDER BY window_end_ts`).all() as Row[];
  logger.info(`Backfilling ${rows.length} window outcomes from Polymarket...`);

  const update = db.prepare(`UPDATE window_outcomes SET polymarket_outcome_up = ? WHERE window_end_ts = ?`);
  let disagreements = 0;
  let agreed = 0;
  let unresolved = 0;
  let alreadyHad = 0;

  for (const r of rows) {
    if (r.polymarket_outcome_up !== null) { alreadyHad++; continue; }
    try {
      const outcome = await fetchSettledOutcome(r.market_slug);
      if (outcome === null) {
        logger.warn("not settled / no outcome", r.market_slug);
        unresolved++;
        continue;
      }
      const polyUp: 0 | 1 | null = outcome === "UP" ? 1 : outcome === "DOWN" ? 0 : null;
      update.run(polyUp, r.window_end_ts);
      if (polyUp !== null && r.outcome_up !== null) {
        if (polyUp === r.outcome_up) agreed++;
        else disagreements++;
      }
      logger.info("settled", { slug: r.market_slug, polymarket: outcome, binanceGuess: r.outcome_up === 1 ? "UP" : "DOWN" });
    } catch (err) {
      logger.warn("fetch failed", r.market_slug, (err as Error).message);
    }
    // small pacing
    await new Promise((res) => setTimeout(res, 200));
  }

  logger.info("Backfill summary", { totalRows: rows.length, alreadyHad, agreed, disagreements, unresolved });
  db.close();
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
