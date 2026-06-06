import { BinanceBtcFeed } from "../btc/binance-ws.js";
import { RollingRealizedVol } from "../btc/volatility.js";
import { logger } from "../logger.js";

const feed = new BinanceBtcFeed();
const vol = new RollingRealizedVol(30);

let count = 0;
feed.onTick((t) => {
  vol.push(t.ts, t.price);
  if (++count % 50 === 0) {
    logger.info("BTC tick", {
      ts: new Date(t.ts).toISOString(),
      price: t.price,
      bid: t.bid,
      ask: t.ask,
      annualVol: vol.annualizedVol()?.toFixed(4),
      vol5m: vol.horizonStdev(5)?.toFixed(6),
    });
  }
});

feed.start();

process.on("SIGINT", () => {
  logger.info("Stopping...");
  feed.stop();
  process.exit(0);
});
