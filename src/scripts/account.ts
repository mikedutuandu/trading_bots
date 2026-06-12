import { logger } from "../logger.js";
import { binance } from "../exchange/binance.js";
import { useVenue } from "../exchange/venue.js";
import { getAccountEquity, getOpenPositions, formatPosition } from "../exchange/account.js";
import { loadPositions } from "../storage/positions.js";
import { getDb, closeDb } from "../storage/db.js";

/**
 * Read-only account snapshot on the TEST venue (or mainnet with VENUE=live).
 * Verifies the API keys + signed requests work, and shows live positions next to
 * what the engine has tracked in SQLite (reconciliation sanity check).
 *
 *   npm run account                 # testnet/demo
 *   VENUE=live npm run account      # mainnet
 */
async function main(): Promise<void> {
  useVenue(process.env.VENUE === "live");
  getDb();
  await binance.syncTime();

  const eq = await getAccountEquity();
  logger.info(
    `equity ${eq.equity.toFixed(2)} USDT  |  wallet ${eq.walletBalance.toFixed(2)}  |  ` +
      `available ${eq.available.toFixed(2)}  |  unrealized ${eq.unrealized.toFixed(2)}`,
  );

  const positions = await getOpenPositions();
  if (positions.length === 0) {
    logger.info("no open positions on the exchange");
  } else {
    for (const p of positions) {
      logger.info(`  ${formatPosition(p)}`);
    }
  }

  const tracked = loadPositions();
  logger.info(`engine is tracking ${tracked.length} position(s) in SQLite`);
  for (const t of tracked) {
    logger.info(`  ${t.symbol}  ${t.pos.side}  qtyRem=${t.pos.qtyRemaining}  stop=${t.pos.stop}  stopId=${t.protectiveStopId}`);
  }

  logger.info(`weight used this minute: ${binance.getUsedWeight()}`);
  closeDb();
}

main().catch((err) => {
  logger.error("account check failed:", err);
  process.exit(1);
});
