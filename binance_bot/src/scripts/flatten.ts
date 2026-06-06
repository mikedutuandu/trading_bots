import { config } from "../config.js";
import { logger } from "../logger.js";
import { getDb, closeDb } from "../storage/db.js";
import { binance } from "../exchange/binance.js";
import { useVenue } from "../exchange/venue.js";
import { getExchangeInfo } from "../exchange/marketData.js";
import { getOpenPositions } from "../exchange/account.js";
import { cancelAllOrders, cancelAlgoOrder, getOpenAlgoOrders, placeMarketOrder } from "../exchange/orders.js";
import { deletePosition } from "../storage/positions.js";

/**
 * Emergency "close everything" — flattens ALL open positions on the venue with
 * reduceOnly market orders and cancels resting orders. Also clears the engine's
 * tracked positions so the DB matches. Use to recover from orphaned/unmanaged
 * positions or to bail out.
 *
 *   npm run flatten                 # testnet/demo
 *   VENUE=live ALLOW_LIVE=true npm run flatten   # mainnet (guarded)
 */
async function main(): Promise<void> {
  const live = process.env.VENUE === "live";
  if (live && !config.allowLive) {
    throw new Error("VENUE=live flatten requires ALLOW_LIVE=true. Refusing to touch mainnet.");
  }
  useVenue(live);
  getDb();
  await binance.syncTime();
  const filters = await getExchangeInfo();

  const positions = await getOpenPositions();
  if (positions.length === 0) {
    logger.info("no open positions — nothing to flatten");
    closeDb();
    return;
  }

  logger.warn(`flattening ${positions.length} position(s) on ${live ? "MAINNET" : "testnet"} …`);
  for (const p of positions) {
    const filter = filters.get(p.symbol);
    if (!filter || p.side === null) {
      logger.warn(`  skip ${p.symbol} (no filter / flat)`);
      continue;
    }
    try {
      await cancelAllOrders(p.symbol); // drop resting basic orders
      await placeMarketOrder(p.symbol, p.side, Math.abs(p.qty), filter, { reduceOnly: true, tag: "flatten" });
      deletePosition(p.symbol);
      logger.info(`  closed ${p.symbol} ${p.side} ${Math.abs(p.qty)}`);
    } catch (err) {
      logger.error(`  failed to close ${p.symbol}:`, err);
    }
  }
  // Cancel ALL conditional (algo) stops in one sweep — covers both the just-closed
  // positions and any orphaned stops not tied to a position.
  for (const a of await getOpenAlgoOrders()) await cancelAlgoOrder(a.symbol, a.algoId);
  logger.info("flatten done");
  closeDb();
}

main().catch((err) => {
  logger.error("flatten failed:", err);
  process.exit(1);
});
