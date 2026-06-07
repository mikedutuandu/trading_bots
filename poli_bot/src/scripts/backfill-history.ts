/**
 * Backfill resolved BTC up/down 5m windows from the Polymarket API into ./data/history.sqlite.
 *
 *   npm run backfill-history -- --days 60            # last 60 days (default)
 *   npm run backfill-history -- --days 7 --conc 8    # custom range + concurrency
 *
 * Two-phase, fully resumable (re-run to fill gaps):
 *   1. Gamma /events (series 10684, closed=true) -> enumerate windows + resolved outcomes.
 *   2. CLOB /prices-history -> the UP-token odds path for each window (handful of points each).
 *
 * Fidelity caveats baked into the data: the odds path is sparse/irregular (thin 5m books) and
 * is a single price per point (no bid/ask/spread). The replay models the ask as mid+half-spread.
 */
import { config } from "../config.js";
import { logger } from "../logger.js";
import { fetchEvents, eventToBtcUpDown } from "../polymarket/gamma.js";
import { fetchPricesHistory } from "../polymarket/clob.js";
import { BTC_UPDOWN_5M_SERIES_ID } from "../polymarket/gamma.js";
import { getHistoryDb } from "../storage/history-db.js";
import type { GammaEvent } from "../types.js";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

function outcomeUp(event: GammaEvent): number | null {
  const market = event.markets?.[0];
  if (!market?.outcomePrices) return null;
  try {
    const prices = JSON.parse(market.outcomePrices) as unknown[];
    const up = Number(prices[0]);
    if (!Number.isFinite(up)) return null;
    if (up >= 0.9) return 1;
    if (up <= 0.1) return 0;
    return null; // tie / not finalized
  } catch {
    return null;
  }
}

/** Run `tasks` with at most `conc` in flight. */
async function pool<T>(items: T[], conc: number, fn: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const days = arg("days", 60);
  const conc = arg("conc", 8);
  const nowMs = Date.now();
  const cutoffMs = nowMs - days * 86_400_000;
  const db = getHistoryDb();

  // ---- Phase 1: enumerate windows via Gamma (ascending from cutoff; stable under new closes) ----
  const upsertWin = db.prepare(`
    INSERT INTO hist_windows (window_end_ts, window_start_ts, slug, up_token, down_token, outcome_up)
    VALUES (@window_end_ts, @window_start_ts, @slug, @up_token, @down_token, @outcome_up)
    ON CONFLICT(window_end_ts) DO UPDATE SET outcome_up = excluded.outcome_up
  `);
  let enumerated = 0;
  logger.info(`Enumerating closed 5m windows for the last ${days} days...`);
  // Gamma caps offset-pagination at 10k results, so walk the range in date chunks small enough
  // that the per-chunk offset never approaches the cap (5 days ~ 1440 windows).
  const CHUNK_MS = 5 * 86_400_000;
  const ingest = db.transaction((evs: GammaEvent[]) => {
    for (const e of evs) {
      const parsed = eventToBtcUpDown(e);
      if (!parsed) continue;
      // Gamma's startDate is when the market was CREATED (~24h early), NOT the 5m window open.
      // The slug carries the true window start: btc-updown-5m-<startTs>, end = start + 300.
      const m = parsed.slug.match(/(\d+)$/);
      if (!m) continue;
      const startTs = Number(m[1]);
      const endTs = startTs + 300;
      if (endTs > Math.floor(nowMs / 1000)) continue;
      upsertWin.run({
        window_end_ts: endTs,
        window_start_ts: startTs,
        slug: parsed.slug,
        up_token: parsed.yesTokenId,
        down_token: parsed.noTokenId,
        outcome_up: outcomeUp(e),
      });
      enumerated++;
    }
  });
  for (let chunkStart = cutoffMs; chunkStart < nowMs; chunkStart += CHUNK_MS) {
    const chunkEnd = Math.min(chunkStart + CHUNK_MS, nowMs);
    let offset = 0;
    while (true) {
      const events = await fetchEvents({
        seriesId: BTC_UPDOWN_5M_SERIES_ID,
        closed: true,
        endDateMin: new Date(chunkStart).toISOString(),
        endDateMax: new Date(chunkEnd).toISOString(),
        order: "endDate",
        ascending: true,
        limit: 100,
        offset,
      });
      if (events.length === 0) break;
      ingest(events);
      offset += events.length;
      if (events.length < 100) break;
    }
    logger.info(`  enumerated ~${enumerated} windows (through ${new Date(chunkEnd).toISOString().slice(0, 10)})...`);
  }
  logger.info(`Phase 1 done: ${enumerated} windows in DB.`);

  // ---- Phase 2: fetch the odds path for windows not yet fetched ----
  const pending = db.prepare(
    `SELECT window_end_ts, window_start_ts, up_token FROM hist_windows WHERE prices_fetched = 0 ORDER BY window_end_ts ASC`,
  ).all() as { window_end_ts: number; window_start_ts: number; up_token: string }[];
  logger.info(`Phase 2: fetching odds paths for ${pending.length} windows (conc=${conc})...`);

  const insPrice = db.prepare(`INSERT OR IGNORE INTO hist_prices (window_end_ts, t, p) VALUES (?, ?, ?)`);
  const markFetched = db.prepare(`UPDATE hist_windows SET prices_fetched = 1 WHERE window_end_ts = ?`);
  let done = 0;
  let withPoints = 0;
  await pool(pending, conc, async (w) => {
    let points: { t: number; p: number }[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Bracket the true 5m window tightly (start-60 .. end+60). 1-min fidelity => ~6-7 points.
        points = await fetchPricesHistory(w.up_token, w.window_start_ts - 60, w.window_end_ts + 60, 1);
        break;
      } catch {
        if (attempt === 2) points = [];
      }
    }
    const tx = db.transaction(() => {
      for (const pt of points) insPrice.run(w.window_end_ts, pt.t, pt.p);
      markFetched.run(w.window_end_ts);
    });
    tx();
    done++;
    if (points.length > 0) withPoints++;
    if (done % 500 === 0) logger.info(`  ${done}/${pending.length} fetched (${withPoints} had points)...`);
  });

  const totalPts = (db.prepare(`SELECT COUNT(*) c FROM hist_prices`).get() as { c: number }).c;
  const resolved = (db.prepare(`SELECT COUNT(*) c FROM hist_windows WHERE outcome_up IS NOT NULL`).get() as { c: number }).c;
  logger.info("Backfill complete", {
    windows: enumerated,
    withResolvedOutcome: resolved,
    windowsWithOdds: withPoints,
    totalPricePoints: totalPts,
  });
  db.close();
}

main().catch((e) => {
  logger.error("backfill-history failed", { error: String(e) });
  process.exit(1);
});
