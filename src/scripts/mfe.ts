import Database from "better-sqlite3";
import { config, envBool } from "../config.js";
import { logger } from "../logger.js";
import { envDateMs, intervalMs } from "../util.js";
import { closeDb, getDb } from "../storage/db.js";
import { getCandles, distinctSymbols } from "../storage/candles.js";
import { binance } from "../exchange/binance.js";
import { getExchangeInfo, scopeSymbols } from "../exchange/marketData.js";
import { resolvePlaybooks } from "../playbooks/index.js";
import { paramsFromEnv } from "../playbooks/paramsFromEnv.js";
import { liveSizingOpts } from "../risk/sizing.js";
import { liveSimFromEnv, runBacktest } from "../backtest/runner.js";

/**
 * MFE/MAE path autopsy — "what did price do, hour by hour, AFTER each entry?"
 * Reconstructs every trade's excursion in R from the research DB's 1h candles
 * (no live logging needed: the candles ARE the hourly log, and they also show the
 * counterfactual AFTER a time-stop closed the trade).
 *
 *   npm run mfe                                  # backtest trades (default: LIVE_SIM + live universe)
 *   MFE_SOURCE=live npm run mfe                  # the real live journal instead
 *   MFE_HORIZON=48 FROM=2025-12-01 npm run mfe   # trace 48 bars, window like backtest
 *
 * Answers: where do winners peak? how fast do trades reach +1R? and for trades the
 * MAX_HOLD time-stop closed: would holding longer have rescued them (touch +1R before
 * the original stop) — i.e. is the current limit cutting trades too early?
 */

interface Row {
  symbol: string;
  side: "long" | "short";
  entry: number;
  rDist: number; // price distance of 1R (riskUsdt / qty)
  openedAt: number;
  closedAt: number;
  closeReason: string;
  netPnl: number;
}

const HORIZON = Number(process.env.MFE_HORIZON ?? 48);
const CHECK = [1, 2, 3, 4, 6, 8, 12, 16, 24, 36, 48].filter((h) => h <= HORIZON);
const barMs = intervalMs(config.strategy.timeframe);

function liveTrades(): Row[] {
  const db = new Database(process.env.MFE_DB ?? "./data/live.sqlite", { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `SELECT symbol, side, entry_price, qty, risk_usdt, opened_at, closed_at, close_reason, net_pnl
       FROM trades WHERE status='CLOSED' AND qty > 0 AND risk_usdt > 0 ORDER BY opened_at`,
    )
    .all() as Array<Record<string, number | string>>;
  db.close();
  return rows.map((r) => ({
    symbol: r.symbol as string,
    side: r.side as Row["side"],
    entry: r.entry_price as number,
    rDist: (r.risk_usdt as number) / (r.qty as number),
    openedAt: r.opened_at as number,
    closedAt: r.closed_at as number,
    closeReason: (r.close_reason as string) ?? "?",
    netPnl: (r.net_pnl as number) ?? 0,
  }));
}

async function backtestTrades(): Promise<Row[]> {
  const symbols = scopeSymbols(distinctSymbols(config.strategy.timeframe));
  const liveSim = envBool("LIVE_SIM", true) // default ON here: judge under live conditions
    ? liveSimFromEnv()
    : undefined;
  const result = await runBacktest({
    symbols,
    playbooks: resolvePlaybooks(process.env.PLAYBOOKS),
    params: paramsFromEnv(),
    startEquity: 1000,
    riskPct: config.risk.riskPct,
    leverage: config.risk.leverage,
    takerFee: config.risk.takerFee,
    slippageBps: config.risk.slippageBps,
    maxOpenPositions: config.risk.maxOpenPositions,
    maxPerSide: config.risk.maxPerSide,
    maxDailyLossPct: config.risk.maxDailyLossPct,
    sizing: liveSizingOpts(),
    liveSim,
    from: envDateMs("FROM"),
    to: envDateMs("TO"),
  });
  return result.trades
    .filter((t) => (t.qty ?? 0) > 0 && (t.riskUsdt ?? 0) > 0)
    .map((t) => ({
      symbol: t.symbol,
      side: t.side,
      entry: t.entryPrice,
      rDist: t.riskUsdt / t.qty,
      openedAt: t.openedAt,
      closedAt: t.closedAt ?? t.openedAt,
      closeReason: t.closeReason ?? "?",
      netPnl: t.netPnl ?? 0,
    }));
}

// One candle query per SYMBOL (covering all its trades) instead of one per TRADE —
// ~2k trades over ~45 symbols would otherwise mean ~2k DB round-trips.
const symbolCandles = new Map<string, ReturnType<typeof getCandles>>();

function loadSymbolCandles(trades: Row[]): void {
  const bySymbol = new Map<string, Row[]>();
  for (const t of trades) (bySymbol.get(t.symbol) ?? bySymbol.set(t.symbol, []).get(t.symbol)!).push(t);
  for (const [symbol, ts] of bySymbol) {
    symbolCandles.set(
      symbol,
      getCandles(symbol, config.strategy.timeframe, {
        from: Math.min(...ts.map((t) => t.openedAt)) + barMs,
        to: Math.max(...ts.map((t) => t.openedAt)) + HORIZON * barMs,
      }),
    );
  }
}

/** Per-bar signed excursions after entry: fav (towards profit) and adv (against), in R. */
function path(t: Row): Array<{ favR: number; advR: number; closeR: number }> {
  const from = t.openedAt + barMs; // bar 0 is the signal candle; the trade lives from bar 1
  const to = t.openedAt + HORIZON * barMs;
  const candles = (symbolCandles.get(t.symbol) ?? []).filter((c) => c.openTime >= from && c.openTime <= to);
  const sgn = t.side === "long" ? 1 : -1;
  return candles.map((c) => ({
    favR: (sgn * ((sgn > 0 ? c.high : c.low) - t.entry)) / t.rDist,
    advR: (sgn * ((sgn > 0 ? c.low : c.high) - t.entry)) / t.rDist,
    closeR: (sgn * (c.close - t.entry)) / t.rDist,
  }));
}

const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pctStr = (n: number, d: number): string => (d ? `${((100 * n) / d).toFixed(0)}%` : "—");

async function main(): Promise<void> {
  const source = process.env.MFE_SOURCE ?? "backtest";
  let trades: Row[];
  if (source === "live") {
    trades = liveTrades();
  } else {
    await binance.syncTime();
    await getExchangeInfo();
    trades = await backtestTrades();
  }
  getDb(); // candles come from the research DB (default DB_PATH)

  const maxHold = paramsFromEnv().maxHoldBars;
  loadSymbolCandles(trades);
  const paths = trades
    .map((t) => ({ t, p: path(t) }))
    .filter(({ p }) => p.length >= Math.min(8, HORIZON)); // skip trades without enough candle history
  logger.info(`mfe: ${paths.length}/${trades.length} trades with candle paths (source=${source}, horizon=${HORIZON} bars)`);

  // ── Hourly table: avg running-max MFE, avg close-R, % touched +1R / −1R by bar h ──
  console.log(`\nHour-by-hour after entry (${paths.length} trades, R = planned risk):`);
  console.log(`  bar │ avg MFE → │ avg close R │ touched +1R │ touched −1R`);
  console.log("  " + "─".repeat(62));
  for (const h of CHECK) {
    const mfes: number[] = [];
    const closes: number[] = [];
    let tp = 0;
    let st = 0;
    for (const { p } of paths) {
      const slice = p.slice(0, h);
      if (!slice.length) continue;
      mfes.push(Math.max(...slice.map((x) => x.favR)));
      closes.push(slice[slice.length - 1]!.closeR);
      if (slice.some((x) => x.favR >= 1)) tp++;
      if (slice.some((x) => x.advR <= -1)) st++;
    }
    console.log(
      `  ${String(h).padStart(3)} │ ${avg(mfes).toFixed(2).padStart(8)}R │ ${avg(closes).toFixed(2).padStart(10)}R │ ${pctStr(tp, paths.length).padStart(11)} │ ${pctStr(st, paths.length).padStart(11)}`,
    );
  }

  // ── Winners vs losers: where does the path peak? ──
  const winners = paths.filter(({ t }) => t.netPnl > 0);
  const losers = paths.filter(({ t }) => t.netPnl <= 0);
  for (const [label, group] of [["winners", winners], ["losers", losers]] as const) {
    if (!group.length) continue;
    const peakBars = group.map(({ p }) => p.reduce((bi, x, i) => (x.favR > p[bi]!.favR ? i : bi), 0) + 1);
    const mfe = group.map(({ p }) => Math.max(...p.map((x) => x.favR)));
    const mae = group.map(({ p }) => Math.min(...p.map((x) => x.advR)));
    console.log(
      `\n${label}: ${group.length} trades · avg MFE ${avg(mfe).toFixed(2)}R (peak at bar ~${Math.round(avg(peakBars))}) · avg MAE ${avg(mae).toFixed(2)}R`,
    );
  }

  // ── Time-stop autopsy: HEALTH_CLOSE at ~maxHold without reaching +1R — would holding on
  //    have rescued the trade (touch +1R before the ORIGINAL stop), in the bars after? ──
  if (maxHold > 0) {
    const stopped = paths.filter(({ t, p }) => {
      const held = Math.round((t.closedAt - t.openedAt) / barMs);
      return t.closeReason === "HEALTH_CLOSE" && Math.abs(held - maxHold) <= 1 && !p.slice(0, maxHold).some((x) => x.favR >= 1);
    });
    let rescued = 0;
    let wouldStop = 0;
    let neither = 0;
    const laterR: number[] = [];
    for (const { p } of stopped) {
      const after = p.slice(maxHold);
      const tpBar = after.findIndex((x) => x.favR >= 1);
      const stBar = after.findIndex((x) => x.advR <= -1);
      if (tpBar >= 0 && (stBar < 0 || tpBar < stBar)) rescued++;
      else if (stBar >= 0) wouldStop++;
      else neither++;
      if (after.length) laterR.push(after[after.length - 1]!.closeR);
    }
    console.log(`\nTime-stop autopsy (HEALTH_CLOSE at ~${maxHold} bars, never reached +1R): ${stopped.length} trades`);
    if (stopped.length) {
      console.log(
        `  if HELD LONGER (next ${HORIZON - maxHold} bars): rescued (+1R first) ${pctStr(rescued, stopped.length)} · ` +
          `hit the stop first ${pctStr(wouldStop, stopped.length)} · drifted (neither) ${pctStr(neither, stopped.length)}`,
      );
      if (laterR.length) {
        console.log(
          `  avg R if simply held to bar ${HORIZON}: ${avg(laterR).toFixed(2)}R  (vs ~0R banked by closing at the limit)`,
        );
      }
    }
  }

  closeDb();
}

main().catch((err) => {
  logger.error("mfe failed:", err);
  process.exit(1);
});
