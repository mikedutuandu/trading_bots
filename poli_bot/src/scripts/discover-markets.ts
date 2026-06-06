import { findActiveBtc5mEvents, pickCurrentBtc5m } from "../polymarket/gamma.js";
import { getOrderBook, bestQuotes } from "../polymarket/clob.js";
import { logger } from "../logger.js";

async function main(): Promise<void> {
  logger.info("Scanning Polymarket BTC 5m series (10684)...");
  const events = await findActiveBtc5mEvents();
  logger.info(`Found ${events.length} upcoming events`);
  for (const e of events.slice(0, 10)) {
    logger.info(" -", e.slug, "ends:", new Date(e.windowEndMs).toISOString());
  }

  const now = Date.now();
  const current = pickCurrentBtc5m(events, now);
  if (!current) {
    logger.warn("No window currently open. Closest upcoming:", events[0]?.slug);
    return;
  }

  const remainingSec = Math.round((current.windowEndMs - now) / 1000);
  logger.info("Current event:", {
    slug: current.slug,
    question: current.question,
    end: new Date(current.windowEndMs).toISOString(),
    remainingSec,
  });

  try {
    const upBook = await getOrderBook(current.yesTokenId);
    const upQ = bestQuotes(upBook);
    logger.info("UP orderbook:", {
      bestBid: upQ.bestBid,
      bestAsk: upQ.bestAsk,
      mid: upQ.mid,
      spread: upQ.spread,
      bidLevels: upBook.bids.length,
      askLevels: upBook.asks.length,
    });
    const downBook = await getOrderBook(current.noTokenId);
    const downQ = bestQuotes(downBook);
    logger.info("DOWN orderbook:", {
      bestBid: downQ.bestBid,
      bestAsk: downQ.bestAsk,
      mid: downQ.mid,
    });
    if (upQ.mid !== null && downQ.mid !== null) {
      logger.info("Sum of mids (sanity check, should ≈ 1):", (upQ.mid + downQ.mid).toFixed(4));
    }
  } catch (err) {
    logger.warn("orderbook fetch failed:", (err as Error).message);
  }
}

main().catch((err) => {
  logger.error(err);
  process.exit(1);
});
