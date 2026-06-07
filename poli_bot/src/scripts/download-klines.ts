/**
 * Download 1m BTCUSDT klines from Binance into ./data/history.sqlite (hist_klines table).
 * Used by the historical replay to reconstruct spot, the window-open strike, and realized vol
 * at full fidelity (this side of the data is NOT coarse).
 *
 *   npm run download-klines -- --days 60
 *
 * Resumable: only fetches minutes newer than the latest stored kline (capped at `days` back).
 */
import { logger } from "../logger.js";
import { getHistoryDb } from "../storage/history-db.js";

// Spot klines. data-api.binance.vision serves the same public data and is less geo-restricted.
const HOSTS = ["https://data-api.binance.vision", "https://api.binance.com"];

type Kline = [number, string, string, string, string, ...unknown[]];

async function fetchKlines(startMs: number, endMs: number): Promise<Kline[]> {
  const qs = `symbol=BTCUSDT&interval=1m&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  let lastErr: unknown;
  for (const host of HOSTS) {
    try {
      const res = await fetch(`${host}/api/v3/klines?${qs}`);
      if (!res.ok) throw new Error(`${res.status}`);
      return (await res.json()) as Kline[];
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`klines fetch failed on all hosts: ${String(lastErr)}`);
}

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
}

async function main(): Promise<void> {
  const days = arg("days", 60);
  const nowMs = Date.now();
  const rangeStartMs = nowMs - days * 86_400_000;
  const db = getHistoryDb();

  const latest = db.prepare(`SELECT MAX(minute_ts) m FROM hist_klines`).get() as { m: number | null };
  let startMs = Math.max(rangeStartMs, latest.m ? (latest.m + 60) * 1000 : 0);

  const ins = db.prepare(`INSERT OR REPLACE INTO hist_klines (minute_ts, open, high, low, close) VALUES (?, ?, ?, ?, ?)`);
  let total = 0;
  logger.info(`Downloading 1m BTCUSDT klines from ${new Date(startMs).toISOString()} ...`);
  while (startMs < nowMs) {
    const endMs = Math.min(startMs + 1000 * 60_000, nowMs);
    const rows = await fetchKlines(startMs, endMs);
    if (rows.length === 0) break;
    const tx = db.transaction((ks: Kline[]) => {
      for (const k of ks) {
        ins.run(Math.floor(k[0] / 1000), Number(k[1]), Number(k[2]), Number(k[3]), Number(k[4]));
      }
    });
    tx(rows);
    total += rows.length;
    const lastOpen = rows[rows.length - 1]![0];
    startMs = lastOpen + 60_000;
    if (total % 10_000 < rows.length) logger.info(`  ${total} klines... (@ ${new Date(lastOpen).toISOString()})`);
    if (rows.length < 1000) break; // reached the present
  }

  const range = db.prepare(`SELECT MIN(minute_ts) a, MAX(minute_ts) b, COUNT(*) c FROM hist_klines`).get() as { a: number; b: number; c: number };
  logger.info("Klines download complete", {
    inserted: total,
    totalRows: range.c,
    first: range.a ? new Date(range.a * 1000).toISOString() : null,
    last: range.b ? new Date(range.b * 1000).toISOString() : null,
  });
  db.close();
}

main().catch((e) => {
  logger.error("download-klines failed", { error: String(e) });
  process.exit(1);
});
