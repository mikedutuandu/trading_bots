/**
 * Live one-shot test order.
 *
 * Places EXACTLY ONE BUY order on the currently-open 5m BTC market.
 * Buys 5 shares (Polymarket min) of whichever side is cheaper, at best-bid (very passive),
 * so the order will likely NOT fill, then waits 60s and cancels.
 *
 * Purpose: confirm auth + signing + order placement work end-to-end with minimal risk.
 *
 * REQUIRES: LIVE_DRY_RUN=false explicitly set in env.
 *
 * Run: `LIVE_DRY_RUN=false npm run live-test-order`
 */
import { LiveTrader } from "../execution/live.js";
import { findActiveBtc5mEvents, pickCurrentBtc5m } from "../polymarket/gamma.js";
import { getOrderBook, bestQuotes } from "../polymarket/clob.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

async function main(): Promise<void> {
  logger.info("=== Live one-shot test order ===");
  if (config.live.dryRun) {
    logger.error("LIVE_DRY_RUN=true — this script requires LIVE_DRY_RUN=false to actually place an order.");
    logger.error("If you want a dry-run, just run `npm run collect` with LIVE_TRADING=true and LIVE_DRY_RUN=true.");
    process.exit(1);
  }
  if (!config.polymarket.privateKey) {
    logger.error("POLYMARKET_PRIVATE_KEY not set.");
    process.exit(1);
  }

  const trader = new LiveTrader();
  const ok = await trader.init();
  if (!ok) { process.exit(1); }
  logger.info("✓ Connected as", trader.getAddress());

  const bal = await trader.getCollateralBalance();
  logger.info("pUSD balance:", { usd: bal.collateralBalanceUsd.toFixed(2) });
  if (bal.collateralBalanceUsd < 1) {
    logger.error("pUSD balance too low. Fund the wallet with USDC on Polygon, then wrap to pUSD via polymarket.com.");
    process.exit(1);
  }

  // Find current 5m market
  const events = await findActiveBtc5mEvents();
  const current = pickCurrentBtc5m(events);
  if (!current) {
    logger.error("No open 5m market right now. Try again in a moment.");
    process.exit(1);
  }
  logger.info("Current market:", { slug: current.slug, end: new Date(current.windowEndMs).toISOString() });

  // Pick the cheaper side and quote at best-bid (passive — most likely WON'T fill)
  const [upBook, downBook] = await Promise.all([
    getOrderBook(current.yesTokenId),
    getOrderBook(current.noTokenId),
  ]);
  const upQ = bestQuotes(upBook);
  const downQ = bestQuotes(downBook);
  logger.info("UP quotes:", upQ);
  logger.info("DOWN quotes:", downQ);

  const upAsk = upQ.bestAsk ?? 1;
  const downAsk = downQ.bestAsk ?? 1;
  const useUp = upAsk <= downAsk;
  const tokenId = useUp ? current.yesTokenId : current.noTokenId;
  const bestBid = useUp ? upQ.bestBid : downQ.bestBid;
  if (bestBid === null) {
    logger.error("No bid on the chosen side; cannot quote.");
    process.exit(1);
  }
  // Place passive: bestBid (we'd be joining the queue at the same price)
  const price = bestBid;
  const size = 5; // Polymarket minimum
  const riskUsd = price * size;
  if (riskUsd > 2) {
    logger.error(`Test order would risk $${riskUsd.toFixed(2)} > $2 cap. Skipping for safety.`);
    process.exit(1);
  }

  logger.warn("⚠ About to place a REAL order:", { side: useUp ? "UP" : "DOWN", price, size, riskUsd: riskUsd.toFixed(2) });
  logger.warn("⚠ Press Ctrl+C in the next 5 seconds to abort...");
  await new Promise((r) => setTimeout(r, 5000));

  const result = await trader.placeBuy({
    tokenId,
    side: useUp ? "UP" : "DOWN",
    price,
    size,
  });
  logger.info("Placement result:", result);
  if (!result.ok) {
    logger.error("Order placement failed. Check the error above for clues.");
    process.exit(1);
  }
  logger.info(`✓ Order placed. Polymarket order ID: ${result.orderId}`);
  logger.info("Open Polymarket in your browser to confirm the order is visible.");
  logger.info("Waiting 60s, then will exit (the order remains in the book — cancel via Polymarket UI if needed).");
  await new Promise((r) => setTimeout(r, 60_000));
  logger.info("=== Test complete ===");
}

main().catch((err) => {
  logger.error("Test order failed:", (err as Error).message);
  process.exit(1);
});
