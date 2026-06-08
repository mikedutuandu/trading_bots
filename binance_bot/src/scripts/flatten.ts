import { config } from "../config.js";
import { logger } from "../logger.js";
import { getDb, closeDb } from "../storage/db.js";
import { binance, briefError } from "../exchange/binance.js";
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
  const attempted: string[] = [];
  for (const p of positions) {
    const filter = filters.get(p.symbol);
    if (!filter || p.side === null) {
      logger.warn(`  skip ${p.symbol} (no filter / flat)`);
      continue;
    }
    attempted.push(p.symbol);
    try {
      await cancelAllOrders(p.symbol); // drop resting basic orders
      await placeMarketOrder(p.symbol, p.side, Math.abs(p.qty), filter, { reduceOnly: true, tag: "flatten" });
      logger.info(`  sent close ${p.symbol} ${p.side} ${Math.abs(p.qty)}`);
    } catch (err) {
      // The demo venue often fills the reduceOnly order yet returns no fill price, so
      // placeMarketOrder throws ("no usable fill price") even though the position closed.
      // Don't trust the throw — verify against exchange truth below before reporting.
      logger.warn(`  close ${p.symbol} reported an error (${briefError(err)}); will verify against exchange`);
    }
  }
  // Cancel ALL conditional (algo) stops in one sweep — covers both the just-closed
  // positions and any orphaned stops not tied to a position.
  for (const a of await getOpenAlgoOrders()) await cancelAlgoOrder(a.symbol, a.algoId);

  // Verify against exchange truth: a thrown close may still have filled. Give the venue
  // a moment to settle, then re-read positions and report what actually happened. Only
  // clear a tracked row once the exchange confirms that symbol is flat.
  await new Promise((r) => setTimeout(r, 1500));
  const stillOpen = new Set((await getOpenPositions()).map((p) => p.symbol));
  for (const sym of attempted) {
    if (stillOpen.has(sym)) {
      logger.error(`  STILL OPEN: ${sym} — close did not go through; re-run flatten or close it manually`);
    } else {
      deletePosition(sym);
      logger.info(`  confirmed flat: ${sym}`);
    }
  }
  const failed = attempted.filter((sym) => stillOpen.has(sym)).length;
  logger.info(`flatten done — ${attempted.length - failed}/${attempted.length} confirmed flat${failed ? `, ${failed} STILL OPEN` : ""}`);
  closeDb();
}

main().catch((err) => {
  logger.error("flatten failed:", err);
  process.exit(1);
});
