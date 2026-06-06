import { config } from "../config.js";
import { logger } from "../logger.js";
import { getExchangeInfo, getUniverse } from "../exchange/marketData.js";
import { lastFill } from "../exchange/orders.js";
import { resolvePlaybooks } from "../playbooks/index.js";
import { paramsFromEnv } from "../playbooks/paramsFromEnv.js";
import { saveTrade } from "../storage/trades.js";
import { deletePosition, loadPositions, savePosition } from "../storage/positions.js";
import type { Broker } from "./broker.js";
import { buildClosedTrade, settleFill, type EngineDeps } from "./loop.js";

/** Resolve the universe + filters + params into the shared EngineDeps. */
export async function buildEngineDeps(opts: { modelFunding: boolean }): Promise<EngineDeps> {
  const filters = await getExchangeInfo();
  const universe = (await getUniverse()).filter((s) => filters.has(s));
  const params = paramsFromEnv();
  const deps: EngineDeps = {
    universe,
    filters,
    playbooks: resolvePlaybooks(process.env.PLAYBOOKS),
    params,
    riskPct: config.risk.riskPct,
    leverage: config.risk.leverage,
    maxOpenPositions: config.risk.maxOpenPositions,
    maxDailyLossPct: config.risk.maxDailyLossPct,
    timeframe: config.strategy.timeframe,
    modelFunding: opts.modelFunding,
    sizing: {
      riskUsdt: config.risk.riskUsdt,
      maxRiskUsdt: config.risk.maxTradeRiskUsdt,
      maxNotional: config.risk.maxNotionalPerTrade,
    },
  };
  const riskDesc =
    config.risk.riskUsdt > 0
      ? `risk=${config.risk.riskUsdt} USDT/trade (fixed)`
      : `risk=${(deps.riskPct * 100).toFixed(2)}%`;
  const caps = [
    config.risk.maxTradeRiskUsdt > 0 ? `maxRisk=${config.risk.maxTradeRiskUsdt}` : null,
    config.risk.maxNotionalPerTrade > 0 ? `maxNotional=${config.risk.maxNotionalPerTrade}` : null,
  ].filter(Boolean);
  logger.info(
    `engine deps: ${universe.length} symbols, playbooks=${deps.playbooks.map((p) => p.name).join("+")}, ` +
      `${riskDesc} lev=${deps.leverage}x maxOpen=${deps.maxOpenPositions}` +
      `${caps.length ? " [" + caps.join(" ") + "]" : ""} ` +
      `ADX≥${params.adxMin} trail=${params.trailMult}xATR TAKE1/2=${params.takeFrac1}/${params.takeFrac2}`,
  );
  return deps;
}

/**
 * Live startup reconcile: align the DB's open positions with the exchange truth.
 * - DB position the exchange no longer holds → it closed while we were down;
 *   finalize the journal at the last fill price and drop the runtime row.
 * - Exchange position we didn't open (no DB row) → warn; we don't manage it.
 */
export async function reconcileLive(broker: Broker, deps: EngineDeps): Promise<void> {
  const tracked = loadPositions();
  for (const ep of tracked) {
    const bpos = await broker.getPosition(ep.symbol);
    if (bpos.qty === 0) {
      const f = await lastFill(ep.symbol).catch(() => null);
      const exitPrice = f?.price ?? ep.pos.stop;
      // Fold the offline exit into the position's running totals, then journal it
      // with the same builder the live close path uses.
      settleFill(ep, ep.pos.side, ep.pos.qtyRemaining, exitPrice, f?.commission ?? 0);
      const reason = ep.pos.tp1Hit ? "MANAGED_STOP" : "STOP";
      saveTrade(buildClosedTrade(ep, exitPrice, reason, Date.now(), deps.leverage, deps.timeframe));
      deletePosition(ep.symbol);
      logger.warn(`reconcile: ${ep.symbol} was closed on the exchange while offline → journaled`);
    } else {
      logger.info(`reconcile: ${ep.symbol} still open on exchange (qty ${bpos.qty})`);
      // Positions opened before the algo-endpoint fix have no exchange stop — place
      // one now so they're protected immediately, not only at the next stop move.
      // setProtectiveStop is best-effort; null on failure → managed on candle close.
      if (ep.protectiveStopId === null) {
        ep.protectiveStopId = await broker.setProtectiveStop(ep.symbol, ep.pos.side, ep.pos.stop, null);
        if (ep.protectiveStopId) {
          savePosition(ep);
          logger.info(`reconcile: placed protective stop for ${ep.symbol} @ ${ep.pos.stop}`);
        }
      }
    }
  }
}
