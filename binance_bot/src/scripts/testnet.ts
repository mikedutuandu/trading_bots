import { logger } from "../logger.js";
import { runEngine } from "../engine/run.js";

/**
 * M7 forward-test — run the engine against the Binance Futures TEST venue
 * (testnet / demo). Places REAL orders with NO real money, so it doubles as the
 * forward-test: live trades should reasonably match the backtest. Same engine,
 * playbooks, sizing and management as the backtest; only the venue is the test API.
 *
 *   npm run testnet                 # loop forever, one tick per 1h candle close
 *   ONESHOT=true npm run testnet    # one tick now, then exit
 *   DRY_RUN=true npm run testnet     # simulate (no orders) to sanity-check wiring
 *   ADX_MIN=25 TRAIL_MULT=3 COOLDOWN=24 TAKE1=0 TAKE2=0.5 npm run testnet
 */
runEngine({ live: false, label: "TESTNET" }).catch((err) => {
  logger.error("testnet run failed:", err);
  process.exit(1);
});
