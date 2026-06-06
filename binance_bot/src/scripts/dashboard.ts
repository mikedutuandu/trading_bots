import { config } from "../config.js";
import { logger } from "../logger.js";
import { startDashboard } from "../dashboard/server.js";

/**
 * M9 — operations dashboard. Reads SQLite and serves a live page (equity curve,
 * open/closed trades, win rate, fees/funding, per-playbook, health). Read-only;
 * runs independently of the engine.
 *
 *   npm run dashboard            # http://localhost:8787
 *   DASHBOARD_PORT=9000 npm run dashboard
 */
startDashboard(config.ops.dashboardPort);
logger.info("dashboard running — Ctrl-C to stop");
