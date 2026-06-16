import { config, envBool } from "../config.js";
import { logger } from "../logger.js";
import { envDateMs } from "../util.js";
import { distinctSymbols } from "../storage/candles.js";
import { getDb, closeDb } from "../storage/db.js";
import { binance } from "../exchange/binance.js";
import { getExchangeInfo, scopeSymbols } from "../exchange/marketData.js";
import { resolvePlaybooks } from "../playbooks/index.js";
import { paramsFromEnv } from "../playbooks/paramsFromEnv.js";
import { liveSizingOpts } from "../risk/sizing.js";
import { liveSimFromEnv, runBacktest } from "../backtest/runner.js";

/**
 * Expectancy by STOP-WIDTH and by SIDE — does the edge differ across volatility?
 * Motivated by the live finding that −1R costs $2.75 (BTC) … $10.55 (ONDO): the notional
 * cap throttles tight-stop (low-ATR) trades, so they run at ~0.3% risk while wide-stop
 * alts run at ~1%. Question: are the under-risked (tight-stop) trades better, worse, or
 * the same on an R basis? stopWidth% = (riskUsdt/qty)/entry = ATRx * ATR%.
 *
 *   LIVE_SIM=true BACKTEST_SYMBOLS=env MAX_PER_SIDE=3 ... npm run risk-buckets
 */

const fmt = (n: number, d = 2) => (n >= 0 ? "+" : "") + n.toFixed(d);

async function main(): Promise<void> {
  await binance.syncTime();
  await getExchangeInfo();
  getDb();
  const symbols = scopeSymbols(distinctSymbols(config.strategy.timeframe));
  const liveSim = envBool("LIVE_SIM", true) ? liveSimFromEnv() : undefined;
  const result = await runBacktest({
    symbols,
    playbooks: resolvePlaybooks(process.env.PLAYBOOKS),
    params: paramsFromEnv(),
    startEquity: 370,
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

  const trades = result.trades.filter((t) => (t.qty ?? 0) > 0 && (t.riskUsdt ?? 0) > 0);

  // stopWidth% = price distance of 1R as a % of entry = (riskUsdt/qty)/entry * 100.
  // Cap binds (under-risk) when stopWidth% < riskPct/maxNotionalPct (≈2% at 1% / 0.5).
  const capThreshold = (config.risk.riskPct / (config.risk.maxNotionalPct || Infinity)) * 100;
  const edges = [0, 1, 1.5, 2, 3, 5, Infinity];
  const label = (i: number) => (edges[i + 1] === Infinity ? `${edges[i]}%+` : `${edges[i]}–${edges[i + 1]}%`);

  type Bucket = { n: number; wins: number; sumR: number; sumRisk: number };
  const buckets: Bucket[] = edges.slice(0, -1).map(() => ({ n: 0, wins: 0, sumR: 0, sumRisk: 0 }));

  for (const t of trades) {
    const swPct = ((t.riskUsdt / t.qty) / t.entryPrice) * 100;
    // edges is sorted; walk up to the last edge swPct is ≥ (final edge = Infinity, never passed).
    let bi = 0;
    while (bi + 1 < edges.length && swPct >= edges[bi + 1]!) bi++;
    const b = buckets[bi]!;
    b.n++;
    if ((t.rRealized ?? 0) > 0) b.wins++;
    b.sumR += t.rRealized ?? 0;
    b.sumRisk += t.riskUsdt;
  }

  logger.info(`risk-buckets: ${trades.length} trades · cap binds below stopWidth ≈ ${capThreshold.toFixed(1)}%`);
  console.log(`\nBy STOP-WIDTH (% of price). Cap throttles risk BELOW ~${capThreshold.toFixed(1)}%:`);
  console.log("  bucket        │  n   │ win%  │ avg R (expectancy) │ total R │ avg $risk");
  console.log("  " + "─".repeat(74));
  buckets.forEach((b, i) => {
    if (!b.n) return;
    const throttled = (edges[i + 1] ?? 0) <= capThreshold ? " (under-risked)" : "";
    console.log(
      `  ${label(i).padEnd(12)} │ ${String(b.n).padStart(4)} │ ${((100 * b.wins) / b.n).toFixed(1).padStart(5)} │ ` +
        `${fmt(b.sumR / b.n, 3).padStart(18)} │ ${fmt(b.sumR, 1).padStart(7)} │ $${(b.sumRisk / b.n).toFixed(2).padStart(6)}${throttled}`,
    );
  });

  // By side, for reference.
  console.log(`\nBy SIDE:`);
  for (const side of ["long", "short"] as const) {
    const ts = trades.filter((t) => t.side === side);
    if (!ts.length) continue;
    const sumR = ts.reduce((s, t) => s + (t.rRealized ?? 0), 0);
    const wins = ts.filter((t) => (t.rRealized ?? 0) > 0).length;
    console.log(
      `  ${side.padEnd(6)} │ ${String(ts.length).padStart(4)} │ ${((100 * wins) / ts.length).toFixed(1)}% win │ ` +
        `avg ${fmt(sumR / ts.length, 3)}R │ total ${fmt(sumR, 1)}R`,
    );
  }

  closeDb();
}

main().catch((err) => {
  logger.error("risk-buckets failed:", err);
  process.exit(1);
});
