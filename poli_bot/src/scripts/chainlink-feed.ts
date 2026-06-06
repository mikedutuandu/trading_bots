import { ChainlinkBtcFeed } from "../btc/chainlink-ws.js";
import { logger } from "../logger.js";

const feed = new ChainlinkBtcFeed();
let count = 0;
feed.onTick((t) => {
  count++;
  if (count <= 5 || count % 20 === 0) {
    logger.info("Chainlink BTC tick", { count, ts: new Date(t.ts).toISOString(), price: t.price });
  }
});
feed.start();

process.on("SIGINT", () => {
  logger.info(`Stopping after ${count} ticks`);
  feed.stop();
  process.exit(0);
});
