import { logger } from "../logger.js";
import { dayKey, sleep } from "../util.js";
import type { Candle, Side, SymbolFilter, Trade } from "../types.js";
import { binance, briefError } from "../exchange/binance.js";
import { getKlines, getMarkPrice } from "../exchange/marketData.js";
import { computeIndicators } from "../playbooks/index.js";
import type { IndicatorCtx, Playbook, StrategyParams } from "../playbooks/types.js";
import { sizePosition, type SizingOpts } from "../risk/sizing.js";
import { closeReasonOf, manageOnCandle, type RuntimePosition } from "../risk/manage.js";
import { saveTrade, lastCloseTime } from "../storage/trades.js";
import {
  deletePosition,
  loadPositions,
  savePosition,
  type EnginePosition,
} from "../storage/positions.js";
import { lastFill } from "../exchange/orders.js";
import {
  dayStartEquity,
  getMeta,
  getMetaNum,
  saveEquitySnapshot,
  setMeta,
} from "../storage/engineState.js";
import { notifyEvent } from "../notifications/telegram.js";
import { maybeBackup } from "./backup.js";
import type { Broker } from "./broker.js";

/**
 * Real-time engine shared by paper & live. One `runTick()` processes the latest
 * CLOSED candle exactly like one bar of the backtest loop: reconcile → manage
 * open positions → scan for entries. All decisions come from the same pure
 * functions the backtest uses (`manageOnCandle`, `sizePosition`, playbook
 * `detect`); only execution differs (via the injected Broker).
 */

export interface EngineDeps {
  universe: string[];
  filters: Map<string, SymbolFilter>;
  playbooks: Playbook[];
  params: StrategyParams;
  riskPct: number;
  leverage: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  timeframe: string;
  modelFunding: boolean; // charge 8h funding (paper only; live gets it from the exchange)
  sizing: SizingOpts; // fixed-USDT risk + hard caps for the real-money phase
}

const EIGHT_H = 8 * 60 * 60 * 1000;
const LAST_TICK_KEY = "engine:lastTickTime";

export function intervalMs(timeframe: string): number {
  const m = /^(\d+)([mhdw])$/.exec(timeframe);
  if (!m) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!]!;
  return n * unit;
}

interface SymbolData {
  candles: Candle[];
  ind: IndicatorCtx;
  idx: number; // index of the latest CLOSED candle
  tickTime: number; // its openTime
}

/** Fetch recent klines, drop the in-progress candle, compute indicators. */
async function fetchSymbolData(
  symbol: string,
  timeframe: string,
  donchianPeriod: number,
  now: number,
): Promise<SymbolData | null> {
  const raw = await getKlines(symbol, timeframe, { limit: 320 });
  const candles = raw.filter((c) => c.closeTime <= now); // only fully-closed candles
  if (candles.length < 250) return null; // need EMA200 warmup
  const idx = candles.length - 1;
  return {
    candles,
    ind: computeIndicators(candles, donchianPeriod),
    idx,
    tickTime: candles[idx]!.openTime,
  };
}

/** Number of 8h funding settlements inside [tickTime, tickTime+barMs). */
function fundingSettlements(tickTime: number, barMs: number): number {
  const first = Math.ceil(tickTime / EIGHT_H) * EIGHT_H;
  let count = 0;
  for (let t = first; t < tickTime + barMs; t += EIGHT_H) count++;
  return count;
}

/** Reconstruct the journal Trade for a position (used on OPEN and on CLOSE upsert). */
function toTrade(ep: EnginePosition, leverage: number, timeframe: string): Trade {
  return {
    id: ep.tradeId,
    symbol: ep.symbol,
    side: ep.pos.side,
    playbook: ep.playbook,
    setup: ep.setup,
    timeframe,
    entryPrice: ep.pos.entry,
    stopPrice: ep.pos.stop,
    qty: ep.pos.qtyTotal,
    notional: ep.notional,
    leverage,
    riskUsdt: ep.riskUsdt,
    rPlanned: ep.rPlanned,
    tp1: ep.pos.tp1,
    tp2: ep.pos.tp2,
    tp3: ep.pos.tp3,
    status: "OPEN",
    openedAt: ep.openedAt,
  };
}

/** Build the CLOSED journal Trade from a position's accumulated PnL (shared by the
 *  live close path and the startup reconcile). Assumes all fills are already
 *  folded into ep.grossPnl/commission/funding (via settleFill). */
export function buildClosedTrade(
  ep: EnginePosition,
  exitPrice: number,
  reason: Trade["closeReason"],
  closedAt: number,
  leverage: number,
  timeframe: string,
): Trade {
  const netPnl = ep.grossPnl - ep.commission + ep.funding;
  return {
    ...toTrade(ep, leverage, timeframe),
    status: "CLOSED",
    exitPrice,
    closeReason: reason,
    rRealized: ep.riskUsdt > 0 ? netPnl / ep.riskUsdt : 0,
    grossPnl: ep.grossPnl,
    commission: ep.commission,
    funding: ep.funding,
    netPnl,
    closedAt,
  };
}

function finalizeClose(
  ep: EnginePosition,
  exitPrice: number,
  reason: Trade["closeReason"],
  closedAt: number,
  leverage: number,
  timeframe: string,
): void {
  const trade = buildClosedTrade(ep, exitPrice, reason, closedAt, leverage, timeframe);
  saveTrade(trade);
  deletePosition(ep.symbol);
  const netPnl = trade.netPnl!;
  logger.info(
    `CLOSE ${ep.symbol} ${ep.pos.side} ${reason} net=${netPnl.toFixed(2)} ` +
      `(gross ${ep.grossPnl.toFixed(2)} fee ${ep.commission.toFixed(2)} fund ${ep.funding.toFixed(2)})`,
  );
  void notifyEvent(
    netPnl >= 0 ? "exit" : "error",
    `<b>CLOSE ${ep.symbol} ${ep.pos.side}</b> ${reason} @ ${exitPrice}\n` +
      `net <b>${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT</b> (${ep.riskUsdt > 0 ? (netPnl / ep.riskUsdt).toFixed(2) : "0"}R)`,
  );
}

/** Process the latest closed candle across the universe. Returns the tick time, or null if skipped. */
export async function runTick(broker: Broker, deps: EngineDeps): Promise<number | null> {
  const now = Date.now();
  const barMs = intervalMs(deps.timeframe);
  const open = new Map<string, EnginePosition>();
  for (const ep of loadPositions()) open.set(ep.symbol, ep);

  // ── 1. Manage existing positions (also fixes the tick time from a live symbol) ──
  let tickTime = 0;
  const equity0 = await broker.getEquity();

  for (const [symbol, ep] of [...open]) {
    const sd = await fetchSymbolData(symbol, deps.timeframe, deps.params.donchianPeriod, now);
    if (!sd) {
      logger.warn(`${symbol}: not enough candles to manage; leaving as-is`);
      continue;
    }
    tickTime = Math.max(tickTime, sd.tickTime);
    // Per-symbol isolation: a thin-book reject (-4131) or other API error on one
    // position must not abort managing the rest. Unsaved state is reloaded next tick.
    try {
      await managePosition(broker, deps, ep, sd, open);
    } catch (err) {
      logger.warn(`${symbol}: manage skipped this tick (${briefError(err)}); retry next bar`);
    }
  }

  // ── 2. Decide whether there's room to scan for entries ──
  const dayStart = dayStartEquity(tickTime || now, equity0);
  const blocked = equity0 <= dayStart * (1 - deps.maxDailyLossPct);
  if (blocked) {
    logger.warn(`kill switch: equity ${equity0.toFixed(2)} ≤ day-start dd cap; no new entries`);
    const day = dayKey(tickTime || now);
    if (getMeta("killswitch:alertedDay") !== day) {
      setMeta("killswitch:alertedDay", day);
      void notifyEvent("halt", `kill switch: daily loss cap hit, halting new entries (${day})`);
    }
  }

  if (!blocked && open.size < deps.maxOpenPositions) {
    for (const symbol of deps.universe) {
      if (open.size >= deps.maxOpenPositions) break;
      if (open.has(symbol)) continue;
      const filter = deps.filters.get(symbol);
      if (!filter) continue;

      const sd = await fetchSymbolData(symbol, deps.timeframe, deps.params.donchianPeriod, now);
      if (!sd) continue;
      tickTime = Math.max(tickTime, sd.tickTime);

      // Per-symbol entry cooldown after a close (cuts over-trading / fees).
      if (deps.params.cooldownBars > 0) {
        const lc = lastCloseTime(symbol);
        if (lc !== null && (sd.tickTime - lc) / barMs < deps.params.cooldownBars) continue;
      }

      // A rejected entry (e.g. -4131 thin book) on one symbol must not stop the scan.
      try {
        await tryEnter(broker, deps, symbol, sd, filter, equity0, open);
      } catch (err) {
        logger.warn(`${symbol}: entry skipped (${briefError(err)})`);
      }
    }
  }

  if (tickTime === 0) {
    logger.warn("no closed candles available this tick");
    return null;
  }

  // ── 3. Bookkeeping ──
  const equity = await broker.getEquity();
  saveEquitySnapshot({
    ts: tickTime,
    equity,
    available: equity,
    marginUsed: 0,
    openPositions: open.size,
  });
  setMeta(LAST_TICK_KEY, String(tickTime));
  maybeBackup(tickTime); // once per UTC day
  logger.info(
    `tick ${new Date(tickTime).toISOString()} done — equity ${equity.toFixed(2)}, ${open.size} open`,
  );
  return tickTime;
}

/** Apply funding, reconcile against the exchange, then run one bar of management. */
async function managePosition(
  broker: Broker,
  deps: EngineDeps,
  ep: EnginePosition,
  sd: SymbolData,
  open: Map<string, EnginePosition>,
): Promise<void> {
  const { symbol } = ep;
  const c = sd.candles[sd.idx]!;
  const barMs = intervalMs(deps.timeframe);

  // ── Funding: charge any 8h settlement landing in this candle (paper sim model) ──
  if (deps.modelFunding) {
    const n = fundingSettlements(sd.tickTime, barMs);
    if (n > 0) {
      try {
        const { lastFundingRate } = await getMarkPrice(symbol);
        const sign = ep.pos.side === "long" ? 1 : -1;
        const notionalNow = ep.pos.qtyRemaining * c.close;
        const cashflow = -sign * lastFundingRate * notionalNow * n;
        ep.funding += cashflow;
        await broker.settleFunding(cashflow);
      } catch (err) {
        logger.warn(`${symbol}: funding fetch failed, skipping settlement`, err);
      }
    }
  }

  // ── Reconcile: the exchange is the source of truth for what's actually open ──
  const bpos = await broker.getPosition(symbol);
  if (bpos.qty === 0) {
    // Closed on the exchange between ticks → almost certainly the protective stop.
    let exitPrice = ep.pos.stop;
    let exitFee = 0;
    if (broker.kind === "live") {
      const f = await lastFill(symbol).catch(() => null);
      if (f) {
        exitPrice = f.price;
        exitFee = f.commission;
      }
    }
    const reason = ep.pos.tp1Hit ? "MANAGED_STOP" : "STOP";
    settleFill(ep, ep.pos.side, ep.pos.qtyRemaining, exitPrice, exitFee);
    ep.pos.qtyRemaining = 0;
    await broker.clearProtectiveStop(symbol, ep.protectiveStopId);
    finalizeClose(ep, exitPrice, reason, sd.tickTime, deps.leverage, deps.timeframe);
    open.delete(symbol);
    return;
  }
  const exchangeQty = Math.abs(bpos.qty);
  if (exchangeQty < ep.pos.qtyRemaining - 1e-9) {
    logger.warn(`${symbol}: exchange qty ${exchangeQty} < tracked ${ep.pos.qtyRemaining}; syncing`);
    ep.pos.qtyRemaining = exchangeQty;
  }

  // ── Manage one bar with the SAME logic as the backtest ──
  const ema50 = sd.ind.ema50[sd.idx]!;
  const ema200 = sd.ind.ema200[sd.idx]!;
  const atrNow = sd.ind.atr14[sd.idx] ?? NaN;
  const barsSinceOpen = Math.round((sd.tickTime - ep.openedAtBarTime) / barMs);
  const stopBefore = ep.pos.stop;

  const { fills, closed } = manageOnCandle(ep.pos, c, {
    bar: barsSinceOpen,
    trendUp: ema50 > ema200,
    atr: atrNow,
    trailMult: deps.params.trailMult,
    maxHoldBars: deps.params.maxHoldBars,
    stallBars: deps.params.stallBars,
    maxTotalBars: deps.params.maxTotalBars,
  });

  for (const f of fills) {
    const res = await broker.marketReduce(symbol, ep.pos.side, f.qty, f.price);
    settleFill(ep, ep.pos.side, res.qty, res.price, res.commission);
  }

  if (closed) {
    const reason = closeReasonOf(fills[fills.length - 1]!.kind);
    const exitPrice = fills[fills.length - 1]!.price;
    await broker.clearProtectiveStop(symbol, ep.protectiveStopId);
    finalizeClose(ep, exitPrice, reason, sd.tickTime, deps.leverage, deps.timeframe);
    open.delete(symbol);
    return;
  }

  // Ensure a protective stop exists on the exchange: place/replace it when the stop
  // moved (breakeven / lock +1R / trail) OR when one is missing (e.g. a position
  // opened before the algo-endpoint fix, or a prior placement that failed).
  // setProtectiveStop is best-effort (never throws) → falls back to candle-close.
  const filter = deps.filters.get(symbol);
  if (filter) {
    const stopMoved = Math.abs(ep.pos.stop - stopBefore) >= filter.tickSize;
    if (stopMoved || ep.protectiveStopId === null) {
      ep.protectiveStopId = await broker.setProtectiveStop(symbol, ep.pos.side, ep.pos.stop, ep.protectiveStopId);
    }
  }
  savePosition(ep);
}

/** Realize a reduce fill into the position's running PnL (mirrors the backtest). */
export function settleFill(
  ep: EnginePosition,
  side: Side,
  qty: number,
  price: number,
  commission = 0,
): void {
  const long = side === "long";
  const gross = long ? (price - ep.pos.entry) * qty : (ep.pos.entry - price) * qty;
  ep.grossPnl += gross;
  ep.commission += commission;
}

/** Detect, size, open, and protect a new position for one symbol. */
async function tryEnter(
  broker: Broker,
  deps: EngineDeps,
  symbol: string,
  sd: SymbolData,
  filter: SymbolFilter,
  equity: number,
  open: Map<string, EnginePosition>,
): Promise<void> {
  for (const pb of deps.playbooks) {
    const signal = pb.detect(sd.candles, sd.idx, sd.ind, deps.params);
    if (!signal) continue;
    const sized = sizePosition(signal, equity, deps.riskPct, deps.leverage, filter, deps.sizing);
    if (!sized) continue;

    await broker.prepareSymbol(symbol, deps.leverage);
    const fill = await broker.marketOpen(symbol, signal.side, sized.qty, sized.entry);

    const pos: RuntimePosition = {
      side: signal.side,
      entry: fill.price, // anchor breakeven to the ACTUAL fill
      stop: sized.stop, // stop/TPs stay anchored to the signal (as in the backtest)
      tp1: sized.tp1,
      tp2: sized.tp2,
      tp3: sized.tp3,
      qtyTotal: fill.qty,
      qtyRemaining: fill.qty,
      qtyTp1: fill.qty * deps.params.takeFrac1,
      qtyTp2: fill.qty * deps.params.takeFrac2,
      tp1Hit: false,
      tp2Hit: false,
      trailActive: false,
      trailExtreme: fill.price,
      openedAtBar: 0,
    };
    const ep: EnginePosition = {
      tradeId: `${symbol}-${sd.tickTime}-${broker.kind}`,
      symbol,
      playbook: signal.playbook,
      setup: signal.setup,
      pos,
      notional: sized.notional,
      riskUsdt: sized.riskUsdt,
      rPlanned: deps.params.rMultiples[2],
      grossPnl: 0,
      commission: fill.commission,
      funding: 0,
      protectiveStopId: null,
      openedAt: sd.tickTime,
      openedAtBarTime: sd.tickTime,
    };
    // Record the position BEFORE placing the protective stop, so a stop failure
    // can never orphan a filled position (the bot still manages it on candle close).
    open.set(symbol, ep);
    savePosition(ep);
    saveTrade(toTrade(ep, deps.leverage, deps.timeframe));

    ep.protectiveStopId = await broker.setProtectiveStop(symbol, signal.side, sized.stop, null);
    if (ep.protectiveStopId) savePosition(ep);

    logger.info(
      `ENTER ${symbol} ${signal.side} ${signal.playbook} qty=${fill.qty} @ ${fill.price} ` +
        `stop=${sized.stop} risk=${sized.riskUsdt.toFixed(2)}`,
    );
    void notifyEvent(
      "entry",
      `<b>ENTER ${symbol} ${signal.side}</b> ${signal.playbook}\n` +
        `qty ${fill.qty} @ ${fill.price}, stop ${sized.stop}, risk ${sized.riskUsdt.toFixed(2)} USDT`,
    );
    return; // one entry per symbol per tick
  }
}

/** True if this candle was already processed (idempotency across restarts/reruns). */
export function alreadyProcessed(tickTime: number): boolean {
  const last = getMetaNum(LAST_TICK_KEY);
  return last !== null && tickTime <= last;
}

/**
 * Run the engine on every candle close. Wakes a short buffer after each timeframe
 * boundary (so the candle is final), re-syncs the clock, and runs one tick. Tick
 * failures are logged and swallowed so the loop survives transient API errors.
 */
export async function runScheduled(
  broker: Broker,
  deps: EngineDeps,
  opts: { settleBufferMs?: number; runImmediately?: boolean } = {},
): Promise<void> {
  const barMs = intervalMs(deps.timeframe);
  const buffer = opts.settleBufferMs ?? 15_000;
  let running = true;
  const stop = () => {
    running = false;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  if (opts.runImmediately) await safeTick(broker, deps);

  while (running) {
    const now = Date.now();
    const nextBoundary = Math.ceil((now + 1) / barMs) * barMs;
    const nextTick = nextBoundary + buffer;
    const wait = nextTick - now;
    setMeta("engine:nextTickTime", String(nextTick)); // dashboard countdown / liveness
    logger.info(`next tick in ${Math.round(wait / 1000)}s (at ${new Date(nextTick).toISOString()})`);
    await sleep(wait);
    if (!running) break;
    await safeTick(broker, deps);
  }
  logger.info("engine loop stopped");
}

async function safeTick(broker: Broker, deps: EngineDeps): Promise<void> {
  try {
    await binance.syncTime();
    await runTick(broker, deps);
  } catch (err) {
    logger.error(`tick failed: ${briefError(err)}`);
    void notifyEvent("error", `tick failed: ${briefError(err)}`);
  }
}
