import { config, envBool } from "../config.js";
import { logger } from "../logger.js";
import { getDb, closeDb } from "../storage/db.js";
import { binance } from "../exchange/binance.js";
import { getExchangeInfo, scopeSymbols } from "../exchange/marketData.js";
import { resolvePlaybooks } from "../playbooks/index.js";
import { envNum, paramsFromEnv } from "../playbooks/paramsFromEnv.js";
import { runBacktest, type BacktestConfig } from "../backtest/runner.js";
import { formatReport } from "../backtest/metrics.js";

/**
 * Run the backtest over collected candles.
 *
 *   npm run backtest
 *   PLAYBOOKS=trend-pullback,trend-breakout npm run backtest
 *   FROM=2025-01-01 TO=2025-06-01 npm run backtest
 *   TRAIN_END=2025-09-01 npm run backtest      # walk-forward: train vs out-of-sample
 *   ATR_MULT=2 ADX_MIN=25 npm run backtest
 *   BACKTEST_SYMBOLS=env npm run backtest      # replay ONLY the live SYMBOLS universe
 *   BACKTEST_SYMBOLS=BTCUSDT,ETHUSDT npm run backtest   # or an explicit list
 *   LIVE_SIM=true BACKTEST_SYMBOLS=env npm run backtest # simulate the LIVE execution
 *       overlay: guardian REVERSAL_CLOSE on the faster TF (needs `TIMEFRAME=15m npm run
 *       collect` first) + TP fills at bar close — the closest replay of `npm run live`
 *
 * NOTE: by default the replay covers EVERY symbol in the research DB (~69) — a WIDER
 * universe than the live engine's SYMBOLS list. To compare against live results, run
 * with BACKTEST_SYMBOLS=env so both trade the same candidate set.
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

async function main(): Promise<void> {
  await binance.syncTime();
  await getExchangeInfo(); // warm the filter cache

  const symbols = scopeSymbols(dbSymbols(config.strategy.timeframe));
  if (symbols.length === 0) {
    throw new Error("No candles in DB. Run `npm run collect` first.");
  }
  logger.info(`universe: ${symbols.length} symbols${process.env.BACKTEST_SYMBOLS ? " (scoped by BACKTEST_SYMBOLS)" : " (ALL research-DB symbols — set BACKTEST_SYMBOLS=env to match live)"}`);

  const params = paramsFromEnv(); // shared with the live engine → backtest-faithful

  // LIVE_SIM mirrors the .env guardian config so the replay matches what `npm run live`
  // would actually do (flip-exits only when MONITOR_REVERSAL_MODE=exit, same reversalTf).
  const liveSim = envBool("LIVE_SIM", false)
    ? { reversalTf: config.monitor.reversalTf, reversalExit: config.monitor.reversalMode === "exit" }
    : undefined;
  if (liveSim) {
    logger.info(
      `LIVE_SIM: guardian ${liveSim.reversalTf} flip-exit ${liveSim.reversalExit ? "ON (MONITOR_REVERSAL_MODE=exit)" : `OFF (mode=${config.monitor.reversalMode})`} + TP fills at bar close`,
    );
  } else if (config.monitor.reversalMode === "exit") {
    logger.info("note: live runs MONITOR_REVERSAL_MODE=exit — add LIVE_SIM=true to replay that behavior");
  }

  const base: Omit<BacktestConfig, "from" | "to"> = {
    symbols,
    liveSim,
    playbooks: resolvePlaybooks(process.env.PLAYBOOKS),
    params,
    startEquity: envNum("EQUITY", 370),
    riskPct: config.risk.riskPct,
    leverage: config.risk.leverage,
    takerFee: config.risk.takerFee,
    slippageBps: config.risk.slippageBps,
    maxOpenPositions: config.risk.maxOpenPositions,
    maxDailyLossPct: config.risk.maxDailyLossPct,
  };

  logger.info(
    `params: ATRx${params.atrStopMult} ADX≥${params.adxMin} TP1/2=${params.rMultiples.slice(0, 2).join("/")}R ` +
      `trail=${params.trailMult}xATR risk=${(base.riskPct * 100).toFixed(2)}% lev=${base.leverage}x maxOpen=${base.maxOpenPositions}`,
  );

  const trainEnd = toMs("TRAIN_END");
  if (trainEnd) {
    // Walk-forward: in-sample up to TRAIN_END, out-of-sample after.
    const train = await runBacktest({ ...base, from: toMs("FROM"), to: trainEnd });
    console.log(formatReport(train, "IN-SAMPLE (train)"));
    const test = await runBacktest({ ...base, from: trainEnd, to: toMs("TO") });
    console.log(formatReport(test, "OUT-OF-SAMPLE (test) ⭐"));
  } else {
    const result = await runBacktest({ ...base, from: toMs("FROM"), to: toMs("TO") });
    console.log(formatReport(result, "full range"));
  }

  closeDb();
}

main().catch((err) => {
  logger.error("backtest failed:", err);
  process.exit(1);
});
