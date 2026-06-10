import { config } from "../config.js";
import { logger } from "../logger.js";
import { getDb, closeDb } from "../storage/db.js";
import { binance } from "../exchange/binance.js";
import { getExchangeInfo, scopeSymbols } from "../exchange/marketData.js";
import { resolvePlaybooks } from "../playbooks/index.js";
import { DEFAULT_PARAMS, type StrategyParams } from "../playbooks/types.js";
import { runBacktest, type BacktestConfig } from "../backtest/runner.js";
import { computeMetrics } from "../backtest/metrics.js";

/**
 * Walk-forward grid search. Tunes parameters on the TRAIN window, then reports each
 * top config's OUT-OF-SAMPLE (test) result — so a config that only works on the test
 * set can't masquerade as an edge. Selection is by TRAIN performance only.
 *
 *   TRAIN_END=2025-12-01 npm run optimize
 */

function toMs(key: string): number | undefined {
  const v = process.env[key];
  return v ? new Date(v).getTime() : undefined;
}

function dbSymbols(interval: string): string[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT DISTINCT symbol FROM candles WHERE interval = ? ORDER BY symbol`)
    .all(interval) as Array<{ symbol: string }>;
  return rows.map((r) => r.symbol);
}


// Parameter grid (kept modest to limit overfitting surface and runtime).
const GRID = {
  adxMin: [25, 40],
  trailMult: [3, 5],
  cooldownBars: [0, 24],
  takeProfile: [
    { takeFrac1: 1 / 3, takeFrac2: 1 / 3, label: "1/3·1/3" },
    { takeFrac1: 0, takeFrac2: 0.5, label: "ride·1/2" },
  ],
  ema200SlopeLookback: [0, 48],
};

interface Combo {
  params: StrategyParams;
  label: string;
}

function buildCombos(): Combo[] {
  const combos: Combo[] = [];
  for (const adxMin of GRID.adxMin)
    for (const trailMult of GRID.trailMult)
      for (const cooldownBars of GRID.cooldownBars)
        for (const tp of GRID.takeProfile)
          for (const ema200SlopeLookback of GRID.ema200SlopeLookback) {
            combos.push({
              params: {
                ...DEFAULT_PARAMS,
                adxMin,
                trailMult,
                cooldownBars,
                takeFrac1: tp.takeFrac1,
                takeFrac2: tp.takeFrac2,
                ema200SlopeLookback,
              },
              label: `ADX${adxMin} trail${trailMult} cd${cooldownBars} ${tp.label} slope${ema200SlopeLookback}`,
            });
          }
  return combos;
}

async function main(): Promise<void> {
  await binance.syncTime();
  await getExchangeInfo();
  const symbols = scopeSymbols(dbSymbols(config.strategy.timeframe));
  if (symbols.length === 0) throw new Error("No candles. Run `npm run collect` first.");
  logger.info(`universe: ${symbols.length} symbols${process.env.BACKTEST_SYMBOLS ? " (scoped by BACKTEST_SYMBOLS)" : ""}`);

  const trainEnd = toMs("TRAIN_END");
  if (!trainEnd) throw new Error("Set TRAIN_END=YYYY-MM-DD for walk-forward optimization");
  const from = toMs("FROM");
  const to = toMs("TO");

  const base: Omit<BacktestConfig, "from" | "to" | "params"> = {
    symbols,
    playbooks: resolvePlaybooks(process.env.PLAYBOOKS),
    startEquity: 370,
    riskPct: config.risk.riskPct,
    leverage: config.risk.leverage,
    takerFee: config.risk.takerFee,
    slippageBps: config.risk.slippageBps,
    maxOpenPositions: config.risk.maxOpenPositions,
    maxDailyLossPct: config.risk.maxDailyLossPct,
  };

  const combos = buildCombos();
  logger.info(`grid: ${combos.length} combos, tuning on train (→ ${process.env.TRAIN_END})`);

  const results: Array<{
    label: string;
    trainNet: number;
    trainPF: number;
    trainTrades: number;
    testNet: number;
    testPF: number;
    testRet: number;
    testDD: number;
    testTrades: number;
  }> = [];

  for (let k = 0; k < combos.length; k++) {
    const { params, label } = combos[k]!;
    const train = computeMetrics(await runBacktest({ ...base, params, from, to: trainEnd }));
    const test = computeMetrics(await runBacktest({ ...base, params, from: trainEnd, to }));
    results.push({
      label,
      trainNet: train.netPnl,
      trainPF: train.profitFactor,
      trainTrades: train.trades,
      testNet: test.netPnl,
      testPF: test.profitFactor,
      testRet: test.returnPct,
      testDD: test.maxDrawdownPct,
      testTrades: test.trades,
    });
    if ((k + 1) % 8 === 0) logger.info(`  ...${k + 1}/${combos.length}`);
  }

  // Rank by TRAIN net (selection uses train only — never test).
  results.sort((a, b) => b.trainNet - a.trainNet);

  const f = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
  const pf = (x: number) => (x === Infinity ? "∞" : x.toFixed(2));
  console.log(`\n${"CONFIG".padEnd(42)} │ TRAIN net/PF/trades │ TEST net/PF/ret%/DD%/trades`);
  console.log("─".repeat(110));
  for (const r of results) {
    const robust = r.trainNet > 0 && r.testNet > 0 ? " ✅both" : "";
    console.log(
      `${r.label.padEnd(42)} │ ${f(r.trainNet).padStart(7)} ${pf(r.trainPF).padStart(4)} ${String(r.trainTrades).padStart(4)} │ ` +
        `${f(r.testNet).padStart(7)} ${pf(r.testPF).padStart(4)} ${f(r.testRet * 100).padStart(6)}% ${(r.testDD * 100).toFixed(0).padStart(3)}% ${String(r.testTrades).padStart(4)}${robust}`,
    );
  }
  console.log("─".repeat(110));
  console.log("Selection is by TRAIN net only. '✅both' = positive on train AND test (the only configs worth trusting).\n");

  closeDb();
}

main().catch((err) => {
  logger.error("optimize failed:", err);
  process.exit(1);
});
