import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { getKlines, getFundingHistory } from "../exchange/marketData.js";
import { notifyEvent } from "../notifications/telegram.js";
import { type Candidate, type XsSignal, avgRate, fundingPnl, pickLongShort, scoreCandidates } from "../signals/crossSectional.js";

/**
 * Cross-sectional PAPER forward-tracker (size 0, no real orders). Defaults to the
 * FUNDING-CARRY signal — the only candidate that survived multi-split + slippage
 * (see memory). One rebalance per invocation, only when H hours have elapsed, so it's
 * safe on a frequent cron. Each rebalance: realize the prior paper book at live prices
 * AND funding, then rank the liquid universe by the signal and open a new book.
 * Accumulates a GENUINE forward out-of-sample track record in its own SQLite.
 *
 *   SIGNAL=funding XSMOM_L=168 XSMOM_H=24 XSMOM_K=5 tsx src/scripts/xsmom-paper.ts
 *
 * SIGNAL: funding (long lowest-funding / short highest-funding) | momentum.
 */

const SIGNAL = (process.env.SIGNAL ?? "funding") as XsSignal;
const L = Number(process.env.XSMOM_L ?? 168); // lookback bars/hours (funding avg window or price lookback)
const H = Number(process.env.XSMOM_H ?? 24); // rebalance/hold period (hours)
const K = Number(process.env.XSMOM_K ?? 5); // K longs + K shorts
const COST = config.risk.takerFee + config.risk.slippageBps / 10_000;
const TF = config.strategy.timeframe;
const PAPER_DB = process.env.XSMOM_DB ?? "./data/xsmom-paper.sqlite";
const RESEARCH_DB = process.env.RESEARCH_DB ?? "./data/binance.sqlite";

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS book (
  symbol      TEXT PRIMARY KEY,
  weight      REAL    NOT NULL,
  entry_price REAL    NOT NULL,
  opened_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS periods (
  ts     INTEGER PRIMARY KEY,
  ret    REAL    NOT NULL,
  fund   REAL    NOT NULL,
  equity REAL    NOT NULL,
  longs  TEXT    NOT NULL,
  shorts TEXT    NOT NULL
);
`;

function openDb(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  return db;
}
function getMeta(db: Database.Database, key: string): string | null {
  return (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null;
}
function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

function resolveUniverse(): string[] {
  if (process.env.XSMOM_SYMBOLS) return process.env.XSMOM_SYMBOLS.split(",").map((s) => s.trim()).filter(Boolean);
  // Curated LIQUID majors from .env — NOT the research DB's full set (thin meme pumps the
  // live book must never touch). The backtest edge largely came from those untradeable names.
  if (config.universe.symbols.length > 0) return config.universe.symbols;
  const rdb = new Database(RESEARCH_DB, { readonly: true, fileMustExist: true });
  try {
    return (rdb.prepare(`SELECT DISTINCT symbol FROM candles WHERE interval = ? ORDER BY symbol`).all(TF) as Array<{ symbol: string }>).map((r) => r.symbol);
  } finally {
    rdb.close();
  }
}

interface BookRow {
  symbol: string;
  weight: number;
  entry_price: number;
  opened_at: number;
}
interface Settlement {
  t: number;
  rate: number;
}

async function main(): Promise<void> {
  const db = openDb(PAPER_DB);
  db.exec(MIGRATIONS);

  if (getMeta(db, "equity") === null) {
    const universe = resolveUniverse();
    setMeta(db, "equity", "1");
    setMeta(db, "universe", JSON.stringify(universe));
    setMeta(db, "params", JSON.stringify({ SIGNAL, L, H, K }));
    logger.info(`xsmom-paper INIT: signal=${SIGNAL}, ${universe.length} symbols, L${L} H${H} K${K}, equity 1.0`);
  }
  const universe: string[] = JSON.parse(getMeta(db, "universe")!);
  let equity = Number(getMeta(db, "equity"));
  const lastTs = getMeta(db, "last_rebalance_ts") ? Number(getMeta(db, "last_rebalance_ts")) : null;

  // Fetch live prices + funding per symbol.
  const nowClose = new Map<string, number>();
  const pastClose = new Map<string, number>();
  const avgFund = new Map<string, number>();
  const settlements = new Map<string, Settlement[]>();
  let nowTs = 0;
  // Fetch klines for the whole universe concurrently (was ~31 serial round-trips).
  const klineResults = await Promise.all(
    universe.map((symbol) =>
      getKlines(symbol, TF, { limit: L + 2 })
        .then((candles) => ({ symbol, candles }))
        .catch((err) => {
          logger.warn(`xsmom-paper: klines failed for ${symbol}: ${String(err)}`);
          return null;
        }),
    ),
  );
  for (const r of klineResults) {
    if (!r || r.candles.length < 2) continue;
    const closed = r.candles.slice(0, -1); // drop the still-forming candle
    const last = closed[closed.length - 1]!;
    nowClose.set(r.symbol, last.close);
    nowTs = Math.max(nowTs, last.openTime);
    const past = closed[closed.length - 1 - L];
    if (past !== undefined) pastClose.set(r.symbol, past.close);
  }
  if (nowTs === 0) throw new Error("no prices fetched");
  // Funding window ends at nowTs (so it must follow the klines fetch); fetch concurrently.
  const fundResults = await Promise.all(
    universe.map((symbol) =>
      getFundingHistory(symbol, { startTime: nowTs - L * 3_600_000, endTime: nowTs })
        .then((rows) => ({ symbol, rows }))
        .catch((err) => {
          logger.warn(`xsmom-paper: funding failed for ${symbol}: ${String(err)}`);
          return null;
        }),
    ),
  );
  for (const r of fundResults) {
    if (!r || r.rows.length === 0) continue;
    settlements.set(r.symbol, r.rows.map((x) => ({ t: x.fundingTime, rate: x.rate })));
    avgFund.set(r.symbol, avgRate(r.rows.map((x) => x.rate)));
  }

  const due = lastTs === null || nowTs - lastTs >= H * 3_600_000;
  const book = db.prepare(`SELECT * FROM book`).all() as BookRow[];

  // Mark-to-market the open book (price only, informational).
  let mtm = 0;
  for (const p of book) {
    const cur = nowClose.get(p.symbol);
    if (cur !== undefined) mtm += p.weight * (cur / p.entry_price - 1);
  }

  if (!due) {
    logger.info(`xsmom-paper: not due (${((nowTs - (lastTs ?? nowTs)) / 3_600_000).toFixed(1)}h/${H}h). equity ${equity.toFixed(4)}, open MTM ${(mtm * 100).toFixed(2)}%`);
    db.close();
    return;
  }

  // --- Rebalance ---
  // 1) Realize the prior book: price PnL + funding PnL over the hold, minus exit fee.
  if (book.length > 0) {
    let priceRet = 0;
    let fundRet = 0;
    for (const p of book) {
      const cur = nowClose.get(p.symbol);
      if (cur !== undefined) priceRet += p.weight * (cur / p.entry_price - 1);
      for (const s of settlements.get(p.symbol) ?? []) {
        if (s.t > p.opened_at && s.t <= nowTs) fundRet += fundingPnl(p.weight, s.rate);
      }
    }
    let turnoverOut = 0;
    for (const p of book) turnoverOut += Math.abs(p.weight);
    const periodRet = priceRet + fundRet - turnoverOut * COST;
    equity *= 1 + periodRet;
    db.prepare(`INSERT OR REPLACE INTO periods (ts, ret, fund, equity, longs, shorts) VALUES (?, ?, ?, ?, ?, ?)`).run(
      nowTs,
      periodRet,
      fundRet,
      equity,
      book.filter((p) => p.weight > 0).map((p) => p.symbol).join(","),
      book.filter((p) => p.weight < 0).map((p) => p.symbol).join(","),
    );
    logger.info(`xsmom-paper: realized ret ${(periodRet * 100).toFixed(2)}% (funding ${(fundRet * 100).toFixed(2)}%) → equity ${equity.toFixed(4)}`);
  }

  // 2) Score the universe and form the new book (shared signal logic — same as backtest/exec).
  const needsPrice = SIGNAL === "momentum" || SIGNAL === "reversal" || SIGNAL === "combo";
  const needsFund = SIGNAL === "funding" || SIGNAL === "combo";
  const cands: Candidate[] = universe
    .filter((s) => nowClose.has(s) && (!needsPrice || pastClose.has(s)) && (!needsFund || avgFund.has(s)))
    .map((s) => ({ symbol: s, priceMom: pastClose.has(s) ? nowClose.get(s)! / pastClose.get(s)! - 1 : 0, avgFund: avgFund.get(s) ?? 0 }));
  const picked = pickLongShort(scoreCandidates(SIGNAL, cands), K);
  if (!picked) throw new Error(`only ${cands.length} eligible symbols (<${2 * K})`);
  const { longs, shorts } = picked;
  const w = 1 / (2 * K);

  equity *= 1 - 1.0 * COST; // open-fee on the new book (1x gross turned over)

  db.prepare(`DELETE FROM book`).run();
  const ins = db.prepare(`INSERT INTO book (symbol, weight, entry_price, opened_at) VALUES (?, ?, ?, ?)`);
  db.transaction(() => {
    for (const sym of longs) ins.run(sym, w, nowClose.get(sym)!, nowTs);
    for (const sym of shorts) ins.run(sym, -w, nowClose.get(sym)!, nowTs);
  })();

  setMeta(db, "equity", String(equity));
  setMeta(db, "last_rebalance_ts", String(nowTs));

  const nPeriods = (db.prepare(`SELECT COUNT(*) AS n FROM periods`).get() as { n: number }).n;
  const fmt = (sym: string) => `${sym} ${((avgFund.get(sym) ?? 0) * 100).toFixed(3)}%`;
  const summary =
    `XS [${SIGNAL}] paper rebalance @ ${new Date(nowTs).toISOString().slice(0, 16)}\n` +
    `equity ${equity.toFixed(4)} (${((equity - 1) * 100).toFixed(1)}% since start, ${nPeriods} periods)\n` +
    `LONG: ${longs.map(fmt).join(", ")}\n` +
    `SHORT: ${shorts.map(fmt).join(", ")}`;
  logger.info(summary.replace(/\n/g, " | "));
  void notifyEvent("info", summary);

  db.close();
}

main().catch((err) => {
  logger.error("xsmom-paper failed:", err);
  process.exit(1);
});
