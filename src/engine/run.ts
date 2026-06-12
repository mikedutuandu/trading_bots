import { config, envBool } from "../config.js";
import { logger } from "../logger.js";
import { sleep } from "../util.js";
import { getDb, closeDb } from "../storage/db.js";
import { saveEquitySnapshot, setMeta } from "../storage/engineState.js";
import { loadPositions } from "../storage/positions.js";
import { binance } from "../exchange/binance.js";
import { useVenue } from "../exchange/venue.js";
import { getExchangeInfo } from "../exchange/marketData.js";
import { getAccountEquity, isHedgeMode, setOneWayMode } from "../exchange/account.js";
import { UserDataStream } from "../exchange/userStream.js";
import { notifyEvent, telegramEnabled } from "../notifications/telegram.js";
import { LiveBroker } from "./liveBroker.js";
import { PaperBroker } from "./paperBroker.js";
import type { Broker } from "./broker.js";
import { buildEngineDeps, reconcileLive } from "./deps.js";
import { runScheduled, runTick, type EngineDeps } from "./loop.js";

export interface RunOptions {
  live: boolean; // false = test venue (risk-free), true = mainnet (real money)
  label: string; // "TESTNET" | "LIVE"
}

function riskLine(): string {
  const r = config.risk;
  const base = r.riskUsdt > 0 ? `${r.riskUsdt} USDT/trade (fixed)` : `${(r.riskPct * 100).toFixed(2)}% equity/trade`;
  const caps = [
    r.maxTradeRiskUsdt > 0 ? `maxRisk ${r.maxTradeRiskUsdt}` : null,
    r.maxNotionalPerTrade > 0 ? `maxNotional ${r.maxNotionalPerTrade}` : null,
  ].filter(Boolean);
  return `${base}${caps.length ? ` | caps: ${caps.join(", ")}` : ""} | ${r.leverage}x | maxOpen ${r.maxOpenPositions}`;
}

/** Mainnet only: loud banner + a countdown (CONFIRM_LIVE already checked up front). */
async function mainnetPreflight(deps: EngineDeps, equity: number): Promise<void> {
  const bar = "═".repeat(60);
  logger.warn(`\n${bar}\n⚠️  LIVE MAINNET — REAL MONEY  ⚠️\n${bar}`);
  logger.warn(`  equity:   ${equity.toFixed(2)} USDT`);
  logger.warn(`  risk:     ${riskLine()}`);
  logger.warn(`  universe: ${deps.universe.length} symbols`);
  logger.warn(`  kill:     halt entries past ${(deps.maxDailyLossPct * 100).toFixed(1)}% daily loss`);
  logger.warn(`${bar}`);
  if (!envBool("SKIP_COUNTDOWN", false)) {
    for (let i = 5; i > 0; i--) {
      logger.warn(`  starting in ${i}s …  (Ctrl-C to abort)`);
      await sleep(1000);
    }
  }
}

/**
 * Single entry point for both the `testnet` and `live` runs. Same engine and
 * broker — they differ only in the venue (endpoint + keys) and the mainnet
 * safety opt-in. Env switches:
 *   DRY_RUN=true   simulate with no orders (sanity-check wiring without the exchange)
 *   ONESHOT=true   run one tick now and exit
 *   RUN_NOW=true   run a tick immediately, then continue on the hourly schedule
 *   NO_STREAM=true skip the user-data WebSocket (REST reconcile is authoritative)
 */
export async function runEngine(opts: RunOptions): Promise<void> {
  const { wsUrl, baseUrl } = useVenue(opts.live);

  if (opts.live) {
    // Two independent keys must BOTH be set to send real mainnet orders.
    if (!config.allowLive) {
      throw new Error(`${opts.label} on mainnet requires ALLOW_LIVE=true. Refusing to send real orders.`);
    }
    if (!config.ops.confirmLive) {
      throw new Error(`${opts.label} on mainnet also requires CONFIRM_LIVE=true (second key). Refusing.`);
    }
  }
  const apiKey = opts.live ? config.binance.apiKey : config.binance.testnetApiKey;
  const apiSecret = opts.live ? config.binance.apiSecret : config.binance.testnetApiSecret;
  if (!apiKey || !apiSecret) {
    throw new Error(`${opts.label} requires API key + secret (${opts.live ? "BINANCE_API_*" : "BINANCE_TESTNET_API_* or BINANCE_API_*"})`);
  }
  logger.info(
    `${opts.label} on ${baseUrl} ${opts.live ? "⚠️  MAINNET — REAL MONEY" : "(risk-free test endpoint ✓)"}`,
  );

  getDb();
  setMeta("engine:label", opts.label); // surfaced on the dashboard so you know which venue produced the data
  await binance.syncTime();
  const filters = await getExchangeInfo();
  const deps = await buildEngineDeps({ modelFunding: false }); // the exchange charges funding

  // Stamp the engine's EFFECTIVE strategy knobs for the dashboard. The dashboard is a
  // separate process whose env can differ (inline overrides on this run) — it must show
  // what THIS engine actually trades with, not recompute from its own env.
  setMeta(
    "engine:params",
    JSON.stringify({
      adxMin: deps.params.adxMin,
      atrMult: deps.params.atrStopMult,
      take1: deps.params.takeFrac1,
      take2: deps.params.takeFrac2,
      trailMult: deps.params.trailMult,
      cooldown: deps.params.cooldownBars,
      maxHold: deps.params.maxHoldBars,
      stall: deps.params.stallBars,
      maxNotional: config.risk.maxNotionalPerTrade,
      maxNotionalPct: config.risk.maxNotionalPct,
      reversalMode: config.monitor.reversalMode,
      reversalTf: config.monitor.reversalTf,
      entryAlign: config.monitor.entryAlign,
      playbooks: deps.playbooks.map((p) => p.name).join("+"),
    }),
  );

  // Strict parse: a typo like DRY_RUN=True must throw, not silently fall through to a
  // real LiveBroker sending real orders (the dangerous direction).
  const dryRun = envBool("DRY_RUN", false);
  let broker: Broker;
  let stream: UserDataStream | null = null;

  if (dryRun) {
    const eq = Number(process.env.EQUITY ?? 10_000);
    broker = new PaperBroker(eq);
    logger.info(`DRY_RUN: simulated broker, equity ${eq} USDT — NO orders will be sent`);
  } else {
    const eq = await getAccountEquity();
    logger.info(
      `account equity ${eq.equity.toFixed(2)} USDT (wallet ${eq.walletBalance.toFixed(2)}, avail ${eq.available.toFixed(2)})`,
    );
    logger.info(`risk: ${riskLine()}`);

    // The engine assumes one-way position mode — enforce it before trading.
    if (await isHedgeMode()) {
      logger.warn("account is in HEDGE mode; switching to ONE-WAY");
      await setOneWayMode();
    }

    if (opts.live) await mainnetPreflight(deps, eq.equity);

    broker = new LiveBroker(filters);
    await reconcileLive(broker, deps);

    if (!envBool("NO_STREAM", false)) {
      stream = new UserDataStream({
        wsUrl,
        onFill: (s, p, q) => logger.info(`stream fill ${s} qty=${q} @ ${p}`),
      });
      await stream.start().catch((err) => logger.warn("could not start user stream:", err));
    }
    if (telegramEnabled) {
      void notifyEvent("info", `${opts.label} engine started — equity ${eq.equity.toFixed(2)} USDT, ${riskLine()}`);
    }
  }

  // Seed an equity snapshot at startup so the dashboard shows the balance
  // immediately, before the first hourly tick records one.
  const startEquity = await broker.getEquity();
  saveEquitySnapshot({
    ts: Date.now(),
    equity: startEquity,
    available: startEquity,
    marginUsed: 0,
    openPositions: loadPositions().length,
  });
  logger.info(`startup equity snapshot: ${startEquity.toFixed(2)} USDT`);

  try {
    if (envBool("ONESHOT", false)) {
      await runTick(broker, deps);
    } else {
      await runScheduled(broker, deps, { runImmediately: envBool("RUN_NOW", false) });
    }
  } finally {
    await stream?.stop();
    closeDb();
  }
}
