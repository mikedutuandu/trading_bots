import { config, envBool } from "../config.js";
import { logger } from "../logger.js";
import { envDateMs } from "../util.js";
import { distinctSymbols } from "../storage/candles.js";
import { getDb, closeDb } from "../storage/db.js";
import { binance } from "../exchange/binance.js";
import { getExchangeInfo, scopeSymbols } from "../exchange/marketData.js";
import { resolvePlaybooks } from "../playbooks/index.js";
import { DEFAULT_PARAMS, type StrategyParams } from "../playbooks/types.js";
import { runBacktest, type BacktestConfig } from "../backtest/runner.js";
import { computeMetrics } from "../backtest/metrics.js";

/**
 * Walk-forward sweep over the levers `optimize.ts` doesn't cover — the ones this
 * project's research found to matter most: initial stop width (ATR_MULT), the TP
 * profile, and the lifecycle time-stops. Same discipline as optimize.ts: tune on
 * TRAIN, report OOS, select by TRAIN only; `✅both` = positive on both.
 *
 *   BACKTEST_SYMBOLS=env TRAIN_END=2025-12-01 npm run sweep
 *   LIVE_SIM=true BACKTEST_SYMBOLS=env TRAIN_END=2025-12-01 npm run sweep   # judge under live conditions
 *
 * Fixed at the live .env's validated values: trail 3×ATR, cooldown 6, maxOpen 4.
 */

const GRID = {
  atrStopMult: [1.5, 2.0, 2.5],
  takeProfile: [
    { takeFrac1: 0.3, takeFrac2: 0.3, label: "0.3/0.3" },
    { takeFrac1: 0.5, takeFrac2: 0.3, label: "0.5/0.3" },
    { takeFrac1: 0.7, takeFrac2: 0.2, label: "0.7/0.2" },
    { takeFrac1: 0, takeFrac2: 0.5, label: "ride/0.5" },
  ],
  timeStops: [
    { maxHoldBars: 48, stallBars: 24, label: "48/24" },
    { maxHoldBars: 12, stallBars: 12, label: "12/12" },
    { maxHoldBars: 0, stallBars: 0, label: "off" },
  ],
  adxMin: [25, 35],
};

interface Combo {
  params: StrategyParams;
  label: string;
}

function buildCombos(): Combo[] {
  const combos: Combo[] = [];
  for (const atrStopMult of GRID.atrStopMult)
    for (const tp of GRID.takeProfile)
      for (const ts of GRID.timeStops)
        for (const adxMin of GRID.adxMin) {
          combos.push({
            params: {
              ...DEFAULT_PARAMS,
              atrStopMult,
              adxMin,
              trailMult: 3,
              cooldownBars: 6,
              takeFrac1: tp.takeFrac1,
              takeFrac2: tp.takeFrac2,
              maxHoldBars: ts.maxHoldBars,
              stallBars: ts.stallBars,
              maxTotalBars: 0,
              ema200SlopeLookback: 0,
            },
            label: `ATR${atrStopMult} TP${tp.label} hold${ts.label} ADX${adxMin}`,
          });
        }
  return combos;
}

async function main(): Promise<void> {
  await binance.syncTime();
  await getExchangeInfo();
  const symbols = scopeSymbols(distinctSymbols(config.strategy.timeframe));
  if (symbols.length === 0) throw new Error("No candles. Run `npm run collect` first.");

  const trainEnd = envDateMs("TRAIN_END");
  if (!trainEnd) throw new Error("Set TRAIN_END=YYYY-MM-DD for walk-forward");
  const from = envDateMs("FROM");
  const to = envDateMs("TO");

  const liveSim = envBool("LIVE_SIM", false)
    ? { reversalTf: config.monitor.reversalTf, reversalExit: config.monitor.reversalMode === "exit" }
    : undefined;

  const base: Omit<BacktestConfig, "from" | "to" | "params"> = {
    symbols,
    playbooks: resolvePlaybooks(process.env.PLAYBOOKS),
    startEquity: 1000,
    riskPct: config.risk.riskPct,
    leverage: config.risk.leverage,
    takerFee: config.risk.takerFee,
    slippageBps: config.risk.slippageBps,
    maxOpenPositions: config.risk.maxOpenPositions,
    maxDailyLossPct: config.risk.maxDailyLossPct,
    liveSim,
  };

  const combos = buildCombos();
  logger.info(
    `sweep: ${combos.length} combos on ${symbols.length} symbols, train→${process.env.TRAIN_END}` +
      `${liveSim ? ` [LIVE_SIM ${liveSim.reversalTf}, flip-exit ${liveSim.reversalExit}]` : ""}`,
  );

  const rows: Array<{
    label: string;
    trainNet: number;
    trainPF: number;
    trainDD: number;
    testNet: number;
    testPF: number;
    testDD: number;
    testTrades: number;
  }> = [];

  for (let k = 0; k < combos.length; k++) {
    const { params, label } = combos[k]!;
    const train = computeMetrics(await runBacktest({ ...base, params, from, to: trainEnd }));
    const test = computeMetrics(await runBacktest({ ...base, params, from: trainEnd, to }));
    rows.push({
      label,
      trainNet: train.netPnl,
      trainPF: train.profitFactor,
      trainDD: train.maxDrawdownPct,
      testNet: test.netPnl,
      testPF: test.profitFactor,
      testDD: test.maxDrawdownPct,
      testTrades: test.trades,
    });
    if ((k + 1) % 12 === 0) logger.info(`  ...${k + 1}/${combos.length}`);
  }

  rows.sort((a, b) => b.trainNet - a.trainNet);

  const f = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;
  const pf = (x: number) => (x === Infinity ? "∞" : x.toFixed(2));
  console.log(`\n${"CONFIG".padEnd(36)} │ TRAIN net/PF/DD%   │ TEST net/PF/DD%/trades`);
  console.log("─".repeat(96));
  for (const r of rows) {
    const both = r.trainNet > 0 && r.testNet > 0 ? " ✅both" : "";
    console.log(
      `${r.label.padEnd(36)} │ ${f(r.trainNet).padStart(6)} ${pf(r.trainPF).padStart(5)} ${(r.trainDD * 100).toFixed(0).padStart(3)}% │ ` +
        `${f(r.testNet).padStart(6)} ${pf(r.testPF).padStart(5)} ${(r.testDD * 100).toFixed(0).padStart(3)}% ${String(r.testTrades).padStart(4)}${both}`,
    );
  }
  console.log("─".repeat(96));
  console.log("Selection by TRAIN net only. ✅both = positive train AND test — the only configs worth trusting.\n");
  closeDb();
}

main().catch((err) => {
  logger.error("sweep failed:", err);
  process.exit(1);
});
