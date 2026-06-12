import { logger } from "../logger.js";
import { runEngine } from "../engine/run.js";

/**
 * M8 — live trading with REAL money on Binance USDT-M Futures (mainnet).
 * Guarded: refuses to run unless ALLOW_LIVE=true. Identical engine to `testnet`;
 * only the venue and the opt-in differ. Start tiny (small RISK_PCT / account).
 *
 *   ALLOW_LIVE=true npm run live              # loop forever on mainnet
 *   ALLOW_LIVE=true ONESHOT=true npm run live # one tick now, then exit
 */
runEngine({ live: true, label: "LIVE" }).catch((err) => {
  logger.error("live run failed:", err);
  process.exit(1);
});
