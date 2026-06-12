import { config } from "../config.js";
import { logger } from "../logger.js";
import { binance } from "../exchange/binance.js";
import { getKlines, getUniverse, getExchangeInfo } from "../exchange/marketData.js";
import { computeIndicators } from "../playbooks/index.js";
import { trendPullback } from "../playbooks/trendPullback.js";
import { paramsFromEnv } from "../playbooks/paramsFromEnv.js";
import { EMA_WARMUP_BARS } from "../risk/guardian.js";

/**
 * "Why is the bot not trading?" — run the REAL detect() against the CURRENT market,
 * symbol by symbol, and show which entry gate blocks each one. Read-only (public
 * klines), zero orders. The verdicts use the same code path as the live engine.
 *
 *   npm run scan
 */

const params = paramsFromEnv();

interface Verdict {
  symbol: string;
  trend: string;
  adx: number;
  gate: string; // first failing gate, or SIGNAL
}

async function scanSymbol(symbol: string): Promise<Verdict | null> {
  const now = Date.now();
  const raw = await getKlines(symbol, config.strategy.timeframe, { limit: 320 });
  const candles = raw.filter((c) => c.closeTime <= now); // closed candles only, like the engine
  if (candles.length < EMA_WARMUP_BARS) return { symbol, trend: "—", adx: NaN, gate: "warmup" };
  const i = candles.length - 1;
  const ind = computeIndicators(candles, params.donchianPeriod);
  const c = candles[i]!;
  const [e20, e50, e200, adx] = [ind.ema20[i]!, ind.ema50[i]!, ind.ema200[i]!, ind.adx14[i]!];

  // The engine's answer — straight from the shared detect().
  const sig = trendPullback.detect(candles, i, ind, params);

  const up = e50 > e200;
  const trend = up ? "↑up" : "↓down";
  if (sig) return { symbol, trend, adx, gate: `SIGNAL ${sig.side.toUpperCase()}` };

  // Why not? Re-walk the gates in detect()'s order to name the first blocker.
  let gate: string;
  if (![e20, e50, e200, ind.atr14[i]!, c.close].every(Number.isFinite) || ind.atr14[i]! <= 0) gate = "warmup/NaN";
  else if (params.adxMin > 0 && !(adx >= params.adxMin)) gate = `ADX ${adx.toFixed(0)} < ${params.adxMin}`;
  else if (up ? c.low > e20 : c.high < e20) gate = "no pullback to EMA20";
  else if (up ? c.close <= e20 : c.close >= e20) gate = "no reclaim of EMA20";
  else gate = up ? "red candle (need green)" : "green candle (need red)";
  return { symbol, trend, adx, gate };
}

async function main(): Promise<void> {
  await binance.syncTime();
  await getExchangeInfo();
  const universe = await getUniverse();
  logger.info(`scan: ${universe.length} symbols, gates ADX≥${params.adxMin} on ${config.strategy.timeframe} (same detect() as the engine)`);

  // Fetch in small parallel batches (sequential = ~45 × 300ms ≈ 14s; batched ≈ 2s,
  // well inside Binance's public rate limits).
  const verdicts: Verdict[] = [];
  const BATCH = 8;
  for (let i = 0; i < universe.length; i += BATCH) {
    const batch = await Promise.all(
      universe.slice(i, i + BATCH).map(async (s) => {
        try {
          return await scanSymbol(s);
        } catch (err) {
          return { symbol: s, trend: "—", adx: NaN, gate: `fetch failed: ${String(err).slice(0, 40)}` };
        }
      }),
    );
    verdicts.push(...batch.filter((v): v is Verdict => v !== null));
  }

  verdicts.sort((a, b) => (b.adx || 0) - (a.adx || 0));
  console.log(`\n${"SYMBOL".padEnd(14)} ${"TREND".padEnd(6)} ${"ADX".padStart(5)}  FIRST BLOCKING GATE`);
  console.log("─".repeat(64));
  for (const v of verdicts) {
    console.log(`${v.symbol.padEnd(14)} ${v.trend.padEnd(6)} ${Number.isFinite(v.adx) ? v.adx.toFixed(0).padStart(5) : "    —"}  ${v.gate}`);
  }

  const byGate = new Map<string, number>();
  for (const v of verdicts) {
    const k = v.gate.startsWith("ADX") ? "ADX below gate" : v.gate.startsWith("SIGNAL") ? "SIGNAL" : v.gate;
    byGate.set(k, (byGate.get(k) ?? 0) + 1);
  }
  console.log("─".repeat(64));
  console.log([...byGate.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}: ${n}`).join(" · "));
  console.log(`(a SIGNAL here would be entered on the NEXT hourly tick if a slot is free)\n`);
}

main().catch((err) => {
  logger.error("scan failed:", err);
  process.exit(1);
});
