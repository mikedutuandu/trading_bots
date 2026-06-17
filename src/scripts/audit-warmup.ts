import { config } from "../config.js";
import { getDb, closeDb } from "../storage/db.js";
import { getCandles } from "../storage/candles.js";
import { ema } from "../indicators/ta.js";

/**
 * AUDIT: does the LIVE engine's 320-candle fetch produce the SAME ema50/ema200 trend
 * verdict as the BACKTEST's full-history computation? The live engine computes all EMAs
 * from only ~319 closed candles (fetchSymbolData limit:320); EMA200 over 319 candles is
 * only 1.6× its period → seed-contaminated / not converged. The backtest uses the full
 * series. Where they disagree on `ema50 > ema200`, live and backtest take DIFFERENT
 * entries and DIFFERENT guardian reversal exits.
 *
 * For each symbol/timeframe, walk recent bars and compare the windowed (live, 319-bar)
 * EMAs against the full-history (backtest) EMAs. Reports the % of bars where the
 * trend verdict flips — i.e. how often live ≠ backtest on the core trend filter.
 *
 *   npx tsx src/scripts/audit-warmup.ts
 */
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XMRUSDT", "TRXUSDT", "ZECUSDT", "ALGOUSDT", "TONUSDT", "BNBUSDT", "ADAUSDT"];

function audit(symbol: string, tf: string, WIN: number): { bars: number; disagree: number } | null {
  const candles = getCandles(symbol, tf, {});
  if (candles.length < WIN + 300) return null;
  const closes = candles.map((c) => c.close);
  const full50 = ema(closes, 50);
  const full200 = ema(closes, 200);

  let bars = 0, disagree = 0;
  // Walk the recent series; each bar i, recompute EMAs from ONLY the live window.
  const start = Math.max(WIN, closes.length - 1500);
  for (let i = start; i < closes.length; i++) {
    const win = closes.slice(i - WIN + 1, i + 1); // the candles live would have at bar i
    const w50 = ema(win, 50);
    const w200 = ema(win, 200);
    const winE50 = w50[w50.length - 1]!, winE200 = w200[w200.length - 1]!;
    const fE50 = full50[i]!, fE200 = full200[i]!;
    if ([winE50, winE200, fE50, fE200].some((x) => Number.isNaN(x))) continue;
    bars++;
    if ((winE50 > winE200) !== (fE50 > fE200)) disagree++; // trend verdict flipped
  }
  return bars ? { bars, disagree } : null;
}

function totalDisagree(tf: string, win: number): { bars: number; dis: number } {
  let tBars = 0, tDis = 0;
  for (const s of SYMBOLS) {
    const r = audit(s, tf, win);
    if (r) { tBars += r.bars; tDis += r.disagree; }
  }
  return { bars: tBars, dis: tDis };
}

function main(): void {
  getDb();
  // WINDOWS: current live fetch (320−1=319) vs the proposed fix (1000−1=999).
  const windows = [319, 999];
  for (const tf of [config.strategy.timeframe, "15m"]) {
    console.log(`\n=== ${tf} — trend-verdict (ema50>ema200) disagreement: live window vs backtest(full history) ===`);
    console.log("fetch window      verdict-DISAGREE vs full history");
    console.log("-".repeat(52));
    for (const win of windows) {
      const { bars, dis } = totalDisagree(tf, win);
      const tag = win === 319 ? " ← current (limit:320)" : " ← proposed (limit:1000)";
      console.log(`${String(win + 1).padStart(4)}-candle fetch   ${(`${dis}/${bars} (${((100 * dis) / bars).toFixed(2)}%)`).padStart(20)}${tag}`);
    }
  }
  closeDb();
}
main();
