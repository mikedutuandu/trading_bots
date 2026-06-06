/**
 * Live trading smoke test.
 *
 * Verifies the LiveTrader can:
 *   1. Initialize (private key valid, derive API creds)
 *   2. Connect to Polymarket CLOB
 *   3. Read USDC balance + allowance
 *
 * Does NOT place any orders. Safe to run any time POLYMARKET_PRIVATE_KEY is set.
 *
 * Run: `npm run live-smoke-test`
 */
import { LiveTrader } from "../execution/live.js";
import { logger } from "../logger.js";
import { config } from "../config.js";

async function main(): Promise<void> {
  logger.info("=== Live smoke test (no orders placed) ===");
  if (!config.polymarket.privateKey) {
    logger.error("POLYMARKET_PRIVATE_KEY not set. Add it to .env and re-run.");
    process.exit(1);
  }

  const trader = new LiveTrader();
  const ok = await trader.init();
  if (!ok) {
    logger.error("LiveTrader failed to initialize. Aborting.");
    process.exit(1);
  }

  logger.info("✓ Connected as", trader.getAddress());

  const bal = await trader.getCollateralBalance();
  logger.info("pUSD (collateral) balance:", { usd: bal.collateralBalanceUsd.toFixed(2) });
  const allowances = Object.entries(bal.collateralAllowances);
  if (allowances.length === 0) {
    logger.warn("⚠ No pUSD allowances set yet. Polymarket can't move your pUSD.");
    logger.warn("   Run the bot with LIVE_DRY_RUN=true first, OR call updateBalanceAllowance() manually.");
  } else {
    for (const [contract, amt] of allowances) {
      logger.info(`  allowance(${contract}): ${amt}`);
    }
  }

  if (bal.collateralBalanceUsd < config.live.maxTradeUsd) {
    logger.warn(`⚠ pUSD balance ($${bal.collateralBalanceUsd.toFixed(2)}) is below LIVE_MAX_TRADE_USD ($${config.live.maxTradeUsd}).`);
    logger.warn("   1. Make sure you've sent USDC to this wallet on Polygon.");
    logger.warn("   2. Visit polymarket.com and sign in — it'll prompt you to wrap USDC → pUSD (1:1, free).");
  } else {
    logger.info("✓ pUSD balance sufficient for at least one live trade at current cap.");
  }

  logger.info("=== Smoke test complete. No orders were placed. ===");
}

main().catch((err) => {
  logger.error("Smoke test failed:", (err as Error).message);
  process.exit(1);
});
