/**
 * Analyze paper_trades + live_trades by various dimensions.
 * Run: `npm run analyze-live`           — both sources
 *      `npm run analyze-live -- paper`  — paper only
 *      `npm run analyze-live -- live`   — live only
 */
import Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../logger.js";

type Row = Record<string, number | string | null>;

interface Trade {
  source: "paper" | "live";
  side: "UP" | "DOWN";
  limit_price: number;
  fair_value_up: number | null;
  edge: number | null;
  realized_vol_at_entry: number | null;
  drift_at_entry: number | null;
  remaining_sec_at_entry: number | null;
  btc_price_at_entry: number | null;
  btc_strike: number | null;
  btc_price_at_close: number | null;
  outcome_up: number | null;
  realized_pnl_usd: number | null;
  risk_usd: number;
}

function bucket(value: number | null, edges: number[], labels: string[]): string {
  if (value === null || !Number.isFinite(value)) return "(null)";
  for (let i = 0; i < edges.length; i++) if (value < edges[i]!) return labels[i]!;
  return labels.at(-1)!;
}

function table(title: string, rows: Row[]): void {
  if (rows.length === 0) { logger.info(`\n=== ${title} ===\n  (no data)`); return; }
  const cols = Object.keys(rows[0]!);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const sep = "  " + widths.map((w) => "-".repeat(w)).join("  ");
  logger.info(`\n=== ${title} ===`);
  logger.info("  " + cols.map((c, i) => c.padEnd(widths[i]!)).join("  "));
  logger.info(sep);
  for (const r of rows) logger.info("  " + cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i]!)).join("  "));
}

function summarize(label: string, ts: Trade[]): Row {
  const wins = ts.filter((t) => (t.side === "UP") === (t.outcome_up === 1)).length;
  const pnl = ts.reduce((s, t) => s + (t.realized_pnl_usd ?? 0), 0);
  const risk = ts.reduce((s, t) => s + t.risk_usd, 0);
  return {
    bucket: label,
    n: ts.length,
    wins,
    winRate: ts.length > 0 ? (100 * wins / ts.length).toFixed(1) + "%" : "—",
    pnl: pnl.toFixed(2),
    roi: risk > 0 ? (100 * pnl / risk).toFixed(1) + "%" : "—",
  };
}

function groupBy(ts: Trade[], key: (t: Trade) => string): Row[] {
  const groups = new Map<string, Trade[]>();
  for (const t of ts) {
    const k = key(t);
    const arr = groups.get(k) ?? [];
    arr.push(t);
    groups.set(k, arr);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => summarize(k, v));
}

function main(): void {
  const filter = process.argv[2]?.toLowerCase();
  const db = new Database(config.collector.dbPath, { readonly: true });
  const trades: Trade[] = [];
  if (filter !== "live") {
    const rows = db.prepare(`
      SELECT side, taker_price AS limit_price, fair_value_up, edge,
             realized_vol_at_entry, drift_at_entry, remaining_sec_at_entry,
             btc_price_at_entry, btc_strike, btc_price_at_close,
             win, realized_pnl_usd, risk_usd
      FROM paper_trades WHERE win IS NOT NULL
    `).all() as Array<Omit<Trade, "source" | "outcome_up"> & { win: number }>;
    for (const r of rows) {
      const upWon = r.side === "UP" ? r.win === 1 : r.win === 0;
      trades.push({ ...r, source: "paper", outcome_up: upWon ? 1 : 0 });
    }
  }
  if (filter !== "paper") {
    const rows = db.prepare(`
      SELECT 'live' AS source, side, limit_price, fair_value_up, edge,
             realized_vol_at_entry, drift_at_entry, remaining_sec_at_entry,
             btc_price_at_entry, btc_strike, btc_price_at_close,
             polymarket_outcome_up AS outcome_up, realized_pnl_usd, risk_usd
      FROM live_trades WHERE polymarket_outcome_up IS NOT NULL
    `).all() as Trade[];
    trades.push(...rows);
  }
  logger.info(`Loaded ${trades.length} resolved trades${filter ? ` (${filter} only)` : ""}.`);
  if (trades.length === 0) { db.close(); return; }

  table("Overall", [summarize("all", trades)]);
  table("By source", groupBy(trades, (t) => t.source));
  table("By side", groupBy(trades, (t) => t.side));
  table("By entry price bucket",
    groupBy(trades, (t) => bucket(t.limit_price, [0.10, 0.30, 0.50, 0.70], ["<0.10", "0.10-0.30", "0.30-0.50", "0.50-0.70", "0.70+"])));

  const enriched = trades.filter((t) => t.edge !== null);
  if (enriched.length === 0) {
    logger.info("\n(No trades have entry context yet — analysis below requires the new schema)");
    db.close();
    return;
  }
  logger.info(`\n(${enriched.length} of ${trades.length} have full entry context)`);

  table("By edge bucket",
    groupBy(enriched, (t) => bucket(t.edge, [0.05, 0.10, 0.15, 0.20], ["<0.05", "0.05-0.10", "0.10-0.15", "0.15-0.20", "0.20+"])));

  table("By realized vol bucket",
    groupBy(enriched, (t) => bucket(t.realized_vol_at_entry, [0.20, 0.30, 0.40, 0.50], ["<0.20", "0.20-0.30", "0.30-0.40", "0.40-0.50", "0.50+"])));

  table("By drift at entry",
    groupBy(enriched, (t) => {
      const d = t.drift_at_entry;
      if (d === null) return "(null)";
      if (d > 0.5) return "strong UP";
      if (d > 0) return "weak UP";
      if (d > -0.5) return "weak DOWN";
      return "strong DOWN";
    }));

  table("By BTC distance from strike at entry",
    groupBy(enriched, (t) => {
      if (t.btc_price_at_entry === null || t.btc_strike === null) return "(null)";
      const d = t.btc_price_at_entry - t.btc_strike;
      return bucket(d, [-50, -10, 10, 50], ["<-50", "-50/-10", "-10/+10", "+10/+50", ">+50"]);
    }));

  table("By time-in-window (remaining sec at entry)",
    groupBy(enriched, (t) => bucket(t.remaining_sec_at_entry, [60, 120, 180, 240], ["<60", "60-120", "120-180", "180-240", "240+"])));

  table("Bot side vs trend at entry",
    groupBy(enriched, (t) => {
      if (t.btc_price_at_entry === null || t.btc_strike === null) return "(null)";
      return `${t.side} into ${t.btc_price_at_entry > t.btc_strike ? "trend-UP" : "trend-DOWN"}`;
    }));

  db.close();
}

main();
