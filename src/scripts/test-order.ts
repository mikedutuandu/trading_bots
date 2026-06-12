import { config } from "../config.js";
import { logger } from "../logger.js";
import { getDb, closeDb } from "../storage/db.js";
import { binance } from "../exchange/binance.js";
import { useVenue } from "../exchange/venue.js";
import { getExchangeInfo, getMarkPrice } from "../exchange/marketData.js";
import { getPosition } from "../exchange/account.js";
import { placeMarketOrder } from "../exchange/orders.js";
import type { Side } from "../types.js";

/**
 * One round-trip order to validate the live execution path: open a MINIMUM-size
 * market position, read the actual fill, then close it (reduceOnly) so the account
 * ends flat. Testnet by default; VENUE=live needs ALLOW_LIVE=true.
 *
 *   npm run test-order                       # tiny BTCUSDT long on testnet, then close
 *   SYMBOL=ETHUSDT SIDE=short npm run test-order
 */
async function main(): Promise<void> {
  const live = process.env.VENUE === "live";
  if (live && !config.allowLive) throw new Error("VENUE=live requires ALLOW_LIVE=true");
  useVenue(live);
  getDb();
  await binance.syncTime();

  const symbol = (process.env.SYMBOL ?? "BTCUSDT").toUpperCase();
  const side = (process.env.SIDE ?? "long") as Side;
  const filters = await getExchangeInfo();
  const filter = filters.get(symbol);
  if (!filter) throw new Error(`no filter for ${symbol}`);

  // Smallest qty that clears both minQty and minNotional (×1.1 buffer for rounding).
  const { markPrice } = await getMarkPrice(symbol);
  const minNotional = filter.minNotional || 5;
  const step = filter.stepSize;
  let qty = Math.max(filter.minQty, (minNotional * 1.1) / markPrice);
  qty = Math.ceil(qty / step) * step;
  logger.info(`test order: ${side} ${symbol} qty=${qty} (~${(qty * markPrice).toFixed(2)} USDT) on ${live ? "MAINNET" : "testnet"}`);

  const open = await placeMarketOrder(symbol, side, qty, filter, { tag: "test" });
  logger.info(`✓ OPEN filled: ${open.qty} @ ${open.price} (fee ${open.commission})`);

  const pos = await getPosition(symbol);
  logger.info(`✓ exchange shows position: qty=${pos.qty} entry=${pos.entry}`);

  const close = await placeMarketOrder(symbol, side, Math.abs(pos.qty), filter, { reduceOnly: true, tag: "test-close" });
  logger.info(`✓ CLOSE filled: ${close.qty} @ ${close.price} (fee ${close.commission})`);

  const after = await getPosition(symbol);
  logger.info(after.qty === 0 ? "✓ account flat again — full order path works ✅" : `⚠️ residual qty ${after.qty}`);
  closeDb();
}

main().catch((err) => {
  logger.error("test-order failed:", err);
  process.exit(1);
});
