import { logger } from "../logger.js";
import { binance } from "../exchange/binance.js";
import { getExchangeInfo, getKlines, getMarkPrice, getUniverse } from "../exchange/marketData.js";

/**
 * M1 gate: verify we can read market data from Binance Futures without keys.
 *   npm run smoke
 */
async function main(): Promise<void> {
  await binance.syncTime();
  logger.info("✓ server time synced");

  const info = await getExchangeInfo();
  logger.info(`✓ exchangeInfo: ${info.size} tradable USDT perpetuals`);
  const btc = info.get("BTCUSDT");
  logger.info(`  BTCUSDT tickSize=${btc?.tickSize} stepSize=${btc?.stepSize} minNotional=${btc?.minNotional}`);

  const candles = await getKlines("BTCUSDT", "1h", { limit: 5 });
  logger.info(`✓ klines: got ${candles.length} BTCUSDT 1h candles`);
  const last = candles[candles.length - 1]!;
  logger.info(`  latest close=${last.close} at ${new Date(last.openTime).toISOString()}`);

  const mark = await getMarkPrice("BTCUSDT");
  logger.info(`✓ markPrice=${mark.markPrice} funding=${(mark.lastFundingRate * 100).toFixed(4)}%`);

  const universe = await getUniverse();
  logger.info(`✓ universe: ${universe.length} symbols`);
  logger.info(`  top 10: ${universe.slice(0, 10).join(", ")}`);

  logger.info(`weight used this minute: ${binance.getUsedWeight()}`);
  logger.info("M1 gate PASSED ✅");
}

main().catch((err) => {
  logger.error("smoke test FAILED:", err);
  process.exit(1);
});
