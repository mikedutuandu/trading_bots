import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { binance, setBaseUrl } from "../exchange/binance.js";
import { useVenue } from "../exchange/venue.js";
import { getExchangeInfo, getMarkPrices, getFundingHistory } from "../exchange/marketData.js";
import { getAccountEquity, getOpenPositions, setLeverage, type ExchangePosition } from "../exchange/account.js";
import { placeMarketOrder } from "../exchange/orders.js";
import { roundToStep } from "../risk/sizing.js";
import { notifyEvent } from "../notifications/telegram.js";
import type { Side, SymbolFilter } from "../types.js";
import { type Candidate, avgRate, pickLongShort, scoreCandidates } from "../signals/crossSectional.js";

/**
 * FUNDING-CARRY executor (cross-sectional long/short). Each run = one rebalance:
 * rank the LIQUID universe by trailing avg funding (MAINNET = the real signal, via the
 * shared crossSectional logic so it can't drift from the backtest), target LONG the K
 * lowest-funding / SHORT the K highest-funding at a small fixed notional, and reconcile
 * the venue to that target (keep same-side legs, close/open only what changed).
 * TINY size — execution validation, not income.
 *
 *   npm run xsmom-testnet                 # demo venue (risk-free) — RUN THIS FIRST
 *   ALLOW_LIVE=true CONFIRM_LIVE=true VENUE=live npm run xsmom-live   # real money, gated
 *
 * Safety: cadence guard (rebalance once per H hours), a per-day KILL-SWITCH
 * (MAX_DAILY_LOSS_PCT → flatten + halt until XSMOM_RESET=true), and an ORPHAN-GUARD
 * that alerts on any exchange position outside the strategy universe (never auto-closes it).
 */

const LIVE = process.env.VENUE === "live";
const DRY = process.env.XSMOM_DRY === "true"; // compute + print the plan, place NO orders (pre-live check)
const L = Number(process.env.XSMOM_L ?? 168); // funding lookback hours
const H = Number(process.env.XSMOM_H ?? 24); // rebalance period hours
const K = Number(process.env.XSMOM_K ?? 5); // K longs + K shorts
const NOTIONAL = Number(process.env.XSMOM_NOTIONAL ?? 12); // USDT per leg (tiny)
const LEV = Number(process.env.XSMOM_LEV ?? 3);
const DB_PATH = process.env.XSMOM_EXEC_DB ?? (LIVE ? "./data/xsmom-live.sqlite" : "./data/xsmom-testnet.sqlite");
const MAINNET = config.binance.baseUrl;
const VENUE = LIVE ? "LIVE" : "testnet";

function db(): Database.Database {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  const d = new Database(DB_PATH);
  d.pragma("journal_mode = WAL");
  d.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS rebalances (ts INTEGER PRIMARY KEY, longs TEXT, shorts TEXT, equity REAL);
          CREATE TABLE IF NOT EXISTS book_legs (symbol TEXT PRIMARY KEY, side TEXT NOT NULL, qty REAL NOT NULL, notional REAL NOT NULL);`);
  return d;
}
const getMeta = (d: Database.Database, k: string): string | null =>
  (d.prepare(`SELECT value FROM meta WHERE key=?`).get(k) as { value: string } | undefined)?.value ?? null;
const setMeta = (d: Database.Database, k: string, v: string): void => {
  d.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, v);
};

async function avgFundingMainnet(symbol: string, since: number): Promise<number | null> {
  const rows = await getFundingHistory(symbol, { startTime: since, endTime: Date.now() });
  return rows.length === 0 ? null : avgRate(rows.map((r) => r.rate));
}

async function closePosition(symbol: string, side: Side, qty: number, filter: SymbolFilter): Promise<void> {
  try {
    await placeMarketOrder(symbol, side, Math.abs(qty), filter, { reduceOnly: true, tag: "xsmom-close" });
    logger.info(`  closed ${symbol} ${side}`);
  } catch (err) {
    logger.warn(`  close ${symbol} threw (may still have filled): ${String(err)}`);
  }
}

async function main(): Promise<void> {
  // Hard live gate (two independent keys), mirroring the M8 engine guard. DRY bypasses it
  // because it places NO orders (read-only mainnet plan preview).
  if (LIVE && !DRY) {
    if (!config.allowLive || !config.ops.confirmLive) {
      throw new Error("VENUE=live needs ALLOW_LIVE=true AND CONFIRM_LIVE=true. Refusing to touch real money.");
    }
    logger.warn("════ XSMOM LIVE — REAL MONEY ════ (tiny size; Ctrl-C now to abort)");
  }
  if (DRY) logger.warn(`xsmom-exec DRY-RUN [${LIVE ? "mainnet" : "testnet"}] — read-only, NO orders.`);

  const store = db();
  setMeta(store, "params", JSON.stringify({ SIGNAL: "funding", L, H, K })); // for the dashboard header
  if (process.env.XSMOM_RESET === "true") {
    setMeta(store, "halted", "0");
    logger.warn("xsmom-exec: kill-switch halt cleared (XSMOM_RESET=true).");
  }
  if (getMeta(store, "halted") === "1") {
    logger.warn("xsmom-exec: HALTED by kill-switch — refusing to trade. Set XSMOM_RESET=true to resume.");
    store.close();
    return;
  }
  const lastTs = getMeta(store, "last_rebalance_ts");
  if (lastTs && Date.now() - Number(lastTs) < H * 3_600_000) {
    const elapsed = (Date.now() - Number(lastTs)) / 3_600_000;
    logger.info(`xsmom-exec: not due (${elapsed.toFixed(1)}h/${H}h). skip.`);
    // Heartbeat on each run so you know the loop is alive (disable: XSMOM_HEARTBEAT=false).
    if (process.env.XSMOM_HEARTBEAT !== "false") {
      void notifyEvent("info", `⏰ xsmom [${VENUE}] alive — not due (${elapsed.toFixed(1)}h/${H}h, next rebalance in ~${(H - elapsed).toFixed(1)}h).`);
    }
    store.close();
    return;
  }

  // XSMOM_EXCLUDE drops symbols that can't size near the per-leg notional (e.g. BTC, whose
  // coarse step forces a much larger position) so the book stays dollar-balanced at small size.
  const exclude = new Set((process.env.XSMOM_EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const universe = (process.env.XSMOM_SYMBOLS ? process.env.XSMOM_SYMBOLS.split(",").map((s) => s.trim()) : config.universe.symbols)
    .filter(Boolean)
    .filter((s) => !exclude.has(s));
  const universeSet = new Set(universe);

  // 1) SIGNAL from MAINNET funding (real edge), via the shared cross-sectional logic.
  setBaseUrl(MAINNET);
  const since = Date.now() - L * 3_600_000;
  const fundResults = await Promise.all(
    universe.map((symbol) =>
      avgFundingMainnet(symbol, since)
        .then((f) => ({ symbol, f }))
        .catch(() => ({ symbol, f: null as number | null })),
    ),
  );
  const cands: Candidate[] = fundResults.filter((r) => r.f !== null).map((r) => ({ symbol: r.symbol, priceMom: 0, avgFund: r.f! }));
  const picked = pickLongShort(scoreCandidates("funding", cands), K);
  if (!picked) throw new Error(`only ${cands.length} symbols with funding (<${2 * K})`);

  // 2) Switch to the ORDER venue.
  useVenue(LIVE);
  await binance.syncTime();
  const eq = await getAccountEquity();
  const filters = await getExchangeInfo();
  const prices = await getMarkPrices();
  logger.info(`xsmom-exec [${VENUE}]: equity ${eq.equity.toFixed(2)} USDT, ${NOTIONAL} USDT/leg, K${K}`);

  // 3) KILL-SWITCH: halt + flatten if today's loss exceeds the cap.
  const today = new Date().toISOString().slice(0, 10);
  if (getMeta(store, "day") !== today) {
    setMeta(store, "day", today);
    setMeta(store, "day_start_equity", String(eq.equity));
  }
  const dayStart = Number(getMeta(store, "day_start_equity") ?? eq.equity);
  const lossPct = dayStart > 0 ? (dayStart - eq.equity) / dayStart : 0;
  if (lossPct >= config.risk.maxDailyLossPct) {
    logger.error(`xsmom-exec: KILL-SWITCH — daily loss ${(lossPct * 100).toFixed(1)}% ≥ ${(config.risk.maxDailyLossPct * 100).toFixed(0)}%. Flattening + halting.`);
    for (const p of await getOpenPositions()) {
      if (universeSet.has(p.symbol) && p.side) await closePosition(p.symbol, p.side, p.qty, filters.get(p.symbol)!);
    }
    setMeta(store, "halted", "1");
    void notifyEvent("halt", `XSMOM ${VENUE} KILL-SWITCH: daily loss ${(lossPct * 100).toFixed(1)}% — flattened + halted. Set XSMOM_RESET=true to resume.`);
    store.close();
    return;
  }

  // 4) Build the target book (signed qty per symbol).
  const target = new Map<string, { side: Side; qty: number }>();
  for (const [syms, side] of [[picked.longs, "long"], [picked.shorts, "short"]] as Array<[string[], Side]>) {
    for (const symbol of syms) {
      const filter = filters.get(symbol);
      const px = prices.get(symbol);
      if (!filter || px === undefined || px <= 0) {
        logger.warn(`  skip ${symbol} (no filter/price on venue)`);
        continue;
      }
      const notional = Math.max(NOTIONAL, filter.minNotional * 1.05);
      const qty = roundToStep(notional / px, filter.stepSize);
      if (qty <= 0) {
        logger.warn(`  skip ${symbol} (qty rounds to 0)`);
        continue;
      }
      target.set(symbol, { side, qty });
    }
  }

  // Balance guard: a book that isn't equal long/short is no longer market-neutral.
  // Legs drop out when NOTIONAL is too small for a high-priced coin's step size — refuse
  // rather than run a lopsided (directional) book. DRY still prints the plan below.
  const nLong = [...target.values()].filter((t) => t.side === "long").length;
  const nShort = [...target.values()].filter((t) => t.side === "short").length;
  if (!DRY && nLong !== nShort) {
    const msg = `unbalanced book ${nLong}L/${nShort}S — raise XSMOM_NOTIONAL or trim high-priced coins. Refusing a non-neutral book.`;
    logger.error(`xsmom-exec: ${msg}`);
    void notifyEvent("halt", `XSMOM ${VENUE}: ${msg}`);
    store.close();
    return;
  }
  // Dollar-balance check (warn, don't block): high-priced coins (BTC) that can't size at the
  // target notional skew the book net-directional. Surface it; the fix is XSMOM_EXCLUDE or a bigger notional.
  const legNotional = (side: Side) => [...target.entries()].filter(([, t]) => t.side === side).reduce((a, [sym, t]) => a + t.qty * (prices.get(sym) ?? 0), 0);
  const longNot = legNotional("long");
  const shortNot = legNotional("short");
  const imbalance = Math.abs(longNot - shortNot) / Math.max(longNot, shortNot, 1);
  if (imbalance > 0.2) {
    const msg = `book ${(imbalance * 100).toFixed(0)}% net-${longNot > shortNot ? "long" : "short"} ($${longNot.toFixed(0)}L / $${shortNot.toFixed(0)}S) — not dollar-neutral at ${NOTIONAL}/leg. Use XSMOM_EXCLUDE=BTCUSDT,BNBUSDT or a bigger XSMOM_NOTIONAL.`;
    logger.warn(`xsmom-exec: ${msg}`);
    void notifyEvent("error", `XSMOM ${VENUE}: ${msg}`);
  }

  // 5) Reconcile: keep same-side legs, close what flipped/exited, open what's new.
  const cur = new Map<string, ExchangePosition>();
  for (const p of await getOpenPositions()) cur.set(p.symbol, p);

  // ORPHAN-GUARD: alert (never auto-close) on exchange positions outside the strategy universe.
  const orphans = [...cur.values()].filter((p) => !universeSet.has(p.symbol));
  if (orphans.length > 0) {
    const list = orphans.map((p) => `${p.symbol} ${p.side}`).join(", ");
    logger.warn(`xsmom-exec: ${orphans.length} position(s) OUTSIDE the strategy universe — leaving alone: ${list}`);
    void notifyEvent("error", `XSMOM ${VENUE}: ${orphans.length} position(s) outside the strategy universe (${list}) — NOT managed by xsmom; verify they're intentional.`);
  }

  const toClose: string[] = [];
  for (const [symbol, p] of cur) {
    if (!universeSet.has(symbol)) continue; // orphan — handled above, never touched
    const t = target.get(symbol);
    if (!t || t.side !== p.side) toClose.push(symbol); // exited or flipped
  }
  const toOpen: string[] = [];
  for (const [symbol, t] of target) {
    const p = cur.get(symbol);
    if (!p || p.side !== t.side) toOpen.push(symbol); // new or flipped (closed first below)
  }

  if (DRY) {
    logger.info(`xsmom-exec DRY plan (NO orders placed):`);
    for (const [sym, t] of target) {
      logger.info(`  TARGET ${t.side.toUpperCase().padEnd(5)} ${sym.padEnd(12)} qty=${t.qty} (~${(t.qty * (prices.get(sym) ?? 0)).toFixed(2)} USDT)`);
    }
    logger.info(`  would CLOSE: ${toClose.join(", ") || "(none)"}`);
    logger.info(`  would OPEN:  ${toOpen.join(", ") || "(none)"}`);
    logger.info(`  current positions in universe: ${[...cur.values()].filter((p) => universeSet.has(p.symbol)).map((p) => `${p.symbol}:${p.side}`).join(", ") || "(none)"}`);
    store.close();
    return;
  }

  for (const symbol of toClose) {
    const p = cur.get(symbol)!;
    if (p.side) await closePosition(symbol, p.side, p.qty, filters.get(symbol)!);
  }
  for (const symbol of toOpen) {
    const t = target.get(symbol)!;
    try {
      await setLeverage(symbol, LEV).catch(() => {});
      await placeMarketOrder(symbol, t.side, t.qty, filters.get(symbol)!, { tag: "xsmom-open" });
      logger.info(`  opened ${symbol} ${t.side} qty=${t.qty}`);
    } catch (err) {
      logger.warn(`  open ${symbol} threw (may still have filled): ${String(err)}`);
    }
  }

  // 6) Verify against exchange truth + record.
  const after = await getOpenPositions();
  const longs = after.filter((p) => p.side === "long" && universeSet.has(p.symbol)).map((p) => p.symbol);
  const shorts = after.filter((p) => p.side === "short" && universeSet.has(p.symbol)).map((p) => p.symbol);
  setMeta(store, "last_rebalance_ts", String(Date.now()));
  store.prepare(`INSERT OR REPLACE INTO rebalances (ts, longs, shorts, equity) VALUES (?, ?, ?, ?)`).run(Date.now(), longs.join(","), shorts.join(","), eq.equity);
  // Per-leg sizes for the dashboard's current-book view (notional = |qty| × mark price).
  store.prepare(`DELETE FROM book_legs`).run();
  const insLeg = store.prepare(`INSERT INTO book_legs (symbol, side, qty, notional) VALUES (?, ?, ?, ?)`);
  for (const p of after) {
    if (p.side && universeSet.has(p.symbol)) insLeg.run(p.symbol, p.side, p.qty, Math.abs(p.qty) * (prices.get(p.symbol) ?? p.entry));
  }
  store.close();

  const summary =
    `XSMOM-carry ${VENUE} rebalanced\n` +
    `equity ${eq.equity.toFixed(2)} USDT | ${NOTIONAL} USDT/leg\n` +
    `LONG (low funding): ${longs.join(", ")}\n` +
    `SHORT (high funding): ${shorts.join(", ")}`;
  logger.info(summary.replace(/\n/g, " | "));
  void notifyEvent("info", summary);
}

// LOOP mode (XSMOM_LOOP_MIN>0): one long-running process that self-schedules — no cron
// needed. It calls the same single-rebalance main() every LOOP_MIN minutes; the cadence
// guard inside still only rebalances every H hours. A failed rebalance is logged, not fatal.
const LOOP_MIN = Number(process.env.XSMOM_LOOP_MIN ?? 0);
if (LOOP_MIN > 0) {
  logger.info(`xsmom-exec LOOP [${VENUE}] — polling every ${LOOP_MIN} min, rebalances every ${H}h. Ctrl-C to stop.`);
  void (async () => {
    for (;;) {
      await main().catch((err) => logger.error("xsmom-exec rebalance failed:", err));
      await new Promise((r) => setTimeout(r, LOOP_MIN * 60_000));
    }
  })();
} else {
  main().catch((err) => {
    logger.error("xsmom-exec failed:", err);
    process.exit(1);
  });
}
