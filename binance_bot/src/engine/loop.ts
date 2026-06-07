import { config } from "../config.js";
import { logger } from "../logger.js";
import { dayKey, sleep } from "../util.js";
import type { Candle, Side, SymbolFilter, Trade } from "../types.js";
import { binance, briefError } from "../exchange/binance.js";
import { getKlines, getMarkPrice } from "../exchange/marketData.js";
import { computeIndicators } from "../playbooks/index.js";
import type { IndicatorCtx, Playbook, StrategyParams } from "../playbooks/types.js";
import { sizePosition, splitTranches, type SizingOpts } from "../risk/sizing.js";
import { closeReasonOf, manageOnCandle, type RuntimePosition } from "../risk/manage.js";
import { saveTrade, lastCloseTime } from "../storage/trades.js";
import { getDb } from "../storage/db.js";
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
import type { Broker, BrokerPosition } from "./broker.js";

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
  // Journal + drop the runtime row ATOMICALLY: a failure between the two would
  // otherwise leave the position journaled-but-not-deleted (re-journaled next pass →
  // double-counted PnL) or deleted-but-not-journaled (silently lost).
  getDb().transaction(() => {
    saveTrade(trade);
    deletePosition(ep.symbol);
  })();
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

/** If the exchange shows this position FLAT, journal the offline close (almost always
 *  the protective stop firing while we weren't managing) and return true. Shared by the
 *  hourly tick and the guardian so the offline-close convention lives in ONE place:
 *  recover the exit price/fee (estimating the taker fee if the fill lookup fails, rather
 *  than journalling 0), settle, tear down the protective stop, and finalize. */
async function reconcileFlat(
  broker: Broker,
  deps: EngineDeps,
  ep: EnginePosition,
  bpos: BrokerPosition,
  closedAt: number,
): Promise<boolean> {
  if (bpos.qty !== 0) return false;
  let exitPrice = ep.pos.stop;
  let exitFee = 0;
  if (broker.kind === "live") {
    const f = await lastFill(ep.symbol).catch(() => null);
    if (f) {
      exitPrice = f.price;
      exitFee = f.commission;
    } else {
      exitFee = config.risk.takerFee * exitPrice * ep.pos.qtyRemaining; // estimate; the stop fill is a taker order
    }
  }
  const reason = ep.pos.tp1Hit ? "MANAGED_STOP" : "STOP";
  settleFill(ep, ep.pos.side, ep.pos.qtyRemaining, exitPrice, exitFee);
  ep.pos.qtyRemaining = 0;
  await broker.clearProtectiveStop(ep.symbol, ep.protectiveStopId);
  finalizeClose(ep, exitPrice, reason, closedAt, deps.leverage, deps.timeframe);
  return true;
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
  if (await reconcileFlat(broker, deps, ep, bpos, sd.tickTime)) {
    open.delete(symbol);
    return;
  }
  // Bidirectional reconcile: the exchange is the source of truth in BOTH directions.
  // (One-directional sync left an under-tracked qty — e.g. from a legacy un-rounded
  // tranche or a partial fill — uncorrectable, drifting funding/PnL.)
  const exchangeQty = Math.abs(bpos.qty);
  if (Math.abs(exchangeQty - ep.pos.qtyRemaining) > 1e-9) {
    logger.warn(`${symbol}: tracked qty ${ep.pos.qtyRemaining} ≠ exchange ${exchangeQty}; syncing to exchange`);
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

  // Persist the DECIDED state (tp1Hit/tp2Hit/stop/qtyRemaining) BEFORE executing the
  // broker fills. If a broker call throws mid-sequence (e.g. TP2 fails after TP1 filled),
  // the DB must not lag the exchange — a stale tp2Hit=false would let the guardian
  // reversal-close a locked runner, or re-fire a TP next tick. Quantity drift is
  // re-synced from exchange truth by the (bidirectional) reconcile next pass.
  if (!closed) savePosition(ep);

  for (const f of fills) {
    const res = await broker.marketReduce(symbol, ep.pos.side, f.qty, f.price);
    settleFill(ep, ep.pos.side, res.qty, res.price, res.commission);
    // manageOnCandle already decremented qtyRemaining by the PLANNED f.qty; if the
    // broker filled a different amount (step rounding / partial fill), absorb the gap
    // so tracked qty stays aligned with exchange truth (paper fills exactly → no-op).
    ep.pos.qtyRemaining += f.qty - res.qty;
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

    // Step-rounded TP tranches off the ACTUAL fill qty (shared with the backtest).
    const { qtyTp1, qtyTp2 } = splitTranches(
      fill.qty,
      deps.params.takeFrac1,
      deps.params.takeFrac2,
      filter.stepSize,
    );
    const pos: RuntimePosition = {
      side: signal.side,
      entry: fill.price, // anchor breakeven to the ACTUAL fill
      stop: sized.stop, // stop/TPs stay anchored to the signal (as in the backtest)
      tp1: sized.tp1,
      tp2: sized.tp2,
      tp3: sized.tp3,
      qtyTotal: fill.qty,
      qtyRemaining: fill.qty,
      qtyTp1,
      qtyTp2,
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

// ─────────────────────────────────────────────────────────────────────────────
// Intra-candle guardian — a LIVE-ONLY safety overlay, NOT modelled by the backtest.
//
// Between the hourly candle-close ticks it checks each OPEN position on the live
// mark price and:
//   A) enforces the bot-managed stop NOW if the mark has breached it — otherwise the
//      hourly tick can let price gap far past the stop on a venue that rejects the
//      resting STOP_MARKET (e.g. the Binance demo endpoint), and
//   B) optionally exits when a faster-timeframe (default 15m) EMA50/EMA200 trend flips
//      against a not-yet-locked position (warn | exit, per config).
// It NEVER opens positions and NEVER runs the candle-close TP ladder — that stays the
// job of runTick (the backtest-faithful path).
// ─────────────────────────────────────────────────────────────────────────────

const LAST_MONITOR_KEY = "engine:lastMonitorTime";
const MONITOR_STATUS_KEY = "monitor:status"; // JSON {symbol:{up,against}} surfaced on the dashboard

/** Per-position guardian status for the dashboard's Monitor column.
 *  `up` = faster-TF (e.g. 15m) is in an uptrend; null = not assessed (reversal off, TP2-locked
 *  runner, or warmup). `against` = that faster-TF trend is against the position's side. */
export interface MonitorStatus {
  up: boolean | null;
  against: boolean;
}

/** Parse the `monitor:status` engine-meta blob — shared by the engine (writer) and the
 *  dashboard (reader) so the wire format is defined once. */
export function parseMonitorStatus(raw: string | null): Record<string, MonitorStatus> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, MonitorStatus>;
  } catch {
    return {};
  }
}

// The faster-TF EMA50/EMA200 verdict can't change until a new reversalTf candle closes,
// so cache it per symbol by that candle boundary — fetch+recompute once per boundary, not
// on every (per-minute) guardian pass.
const reversalTrend = new Map<string, { boundary: number; uptrend: boolean }>();

/** Is the faster timeframe (e.g. 15m) in an uptrend (EMA50 > EMA200)? null until EMA200 warms up.
 *  Reuses fetchSymbolData (the same fetch / drop-in-progress-candle / warmup / indicator pipeline as
 *  the hourly tick), cached per reversalTf candle boundary so it computes at most once per boundary. */
async function fasterTfUptrend(symbol: string, donchianPeriod: number): Promise<boolean | null> {
  const tfMs = intervalMs(config.monitor.reversalTf);
  const boundary = Math.floor(Date.now() / tfMs) * tfMs;
  let cached = reversalTrend.get(symbol);
  if (!cached || cached.boundary !== boundary) {
    const sd = await fetchSymbolData(symbol, config.monitor.reversalTf, donchianPeriod, Date.now());
    if (!sd) return null; // not enough candles to warm up EMA200 (don't cache a warmup miss)
    const ema50 = sd.ind.ema50[sd.idx];
    const ema200 = sd.ind.ema200[sd.idx];
    if (ema50 === undefined || ema200 === undefined || Number.isNaN(ema50) || Number.isNaN(ema200)) {
      return null;
    }
    cached = { boundary, uptrend: ema50 > ema200 };
    reversalTrend.set(symbol, cached);
  }
  return cached.uptrend;
}

/** Market-close the whole remaining position NOW and journal it with `reason`. */
async function guardianClose(
  broker: Broker,
  deps: EngineDeps,
  ep: EnginePosition,
  priceHint: number,
  reason: Trade["closeReason"],
  detail: string,
): Promise<void> {
  const res = await broker.marketReduce(ep.symbol, ep.pos.side, ep.pos.qtyRemaining, priceHint);
  settleFill(ep, ep.pos.side, res.qty, res.price, res.commission);
  ep.pos.qtyRemaining -= res.qty;
  // Partial fill (illiquid book / stop fired mid-pass): keep the position tracked and
  // protected and retry next pass — never finalize (delete) with qty still open, which
  // would orphan the remainder on the exchange.
  if (ep.pos.qtyRemaining > 1e-9) {
    logger.warn(`GUARDIAN ${reason} ${ep.symbol}: partial fill ${res.qty}, ${ep.pos.qtyRemaining} left — retry next pass`);
    savePosition(ep);
    return;
  }
  await broker.clearProtectiveStop(ep.symbol, ep.protectiveStopId);
  logger.warn(`GUARDIAN ${reason} ${ep.symbol} ${ep.pos.side}: ${detail}`);
  finalizeClose(ep, res.price, reason, Date.now(), deps.leverage, deps.timeframe);
}

/** One guardian pass over a single open position. Returns the position's monitor status
 *  (faster-TF trend) for the dashboard, or null if the position was closed this pass. */
async function guardPosition(
  broker: Broker,
  deps: EngineDeps,
  ep: EnginePosition,
): Promise<{ up: boolean | null; against: boolean } | null> {
  const { symbol } = ep;

  // 1. Reconcile vs the exchange — if it already closed (e.g. the resting stop fired),
  //    journal it via the same close path the hourly tick uses.
  const bpos = await broker.getPosition(symbol);
  if (await reconcileFlat(broker, deps, ep, bpos, Date.now())) return null;
  // Keep tracked qty aligned with exchange truth (bidirectional).
  const exchangeQty = Math.abs(bpos.qty);
  if (Math.abs(exchangeQty - ep.pos.qtyRemaining) > 1e-9) {
    ep.pos.qtyRemaining = exchangeQty;
    savePosition(ep);
  }

  // 2. Live mark price (best-effort; show neutral status if it's unavailable this pass).
  const { markPrice } = await getMarkPrice(symbol);
  if (!Number.isFinite(markPrice) || markPrice <= 0) return { up: null, against: false };
  const long = ep.pos.side === "long";

  // 3. Layer A — enforce the bot-managed stop intra-candle (don't wait for the hourly tick).
  const stopBreached = long ? markPrice <= ep.pos.stop : markPrice >= ep.pos.stop;
  if (stopBreached) {
    await guardianClose(broker, deps, ep, ep.pos.stop, "GUARDIAN_STOP", `mark ${markPrice} breached stop ${ep.pos.stop}`);
    return null;
  }

  // 4. Layer B — faster-TF trend. Only assess/act while NOT locked (pre-TP2): a TP2 runner
  //    is left to the chandelier trail. `up`=null → not assessed (off / TP2 / warmup).
  if (config.monitor.reversalMode === "off" || ep.pos.tp2Hit) {
    return { up: null, against: false };
  }
  const up = await fasterTfUptrend(symbol, deps.params.donchianPeriod);
  const against = up !== null && (long ? !up : up); // long against = downtrend; short against = uptrend
  if (against && config.monitor.reversalMode === "exit") {
    await guardianClose(broker, deps, ep, markPrice, "REVERSAL_CLOSE", `${config.monitor.reversalTf} trend flipped against ${ep.pos.side}`);
    return null;
  }
  return { up, against }; // warn mode keeps it open; `against` drives the dashboard ⚠ + the alert
}

/** Fast safety loop: check every open position on the live mark. Per-symbol isolated
 *  (one symbol's API error can't abort the rest), no entries, no candle-close ladder. */
export async function monitorOpenPositions(broker: Broker, deps: EngineDeps): Promise<void> {
  const now = Date.now();
  setMeta(LAST_MONITOR_KEY, String(now));
  const open = loadPositions();
  if (open.length === 0) {
    setMeta(MONITOR_STATUS_KEY, "{}");
    return;
  }
  const prev = parseMonitorStatus(getMeta(MONITOR_STATUS_KEY));
  const status: Record<string, MonitorStatus> = {};
  for (const ep of open) {
    try {
      const s = await guardPosition(broker, deps, ep);
      if (!s) continue; // closed this pass → drop from the status map
      status[ep.symbol] = s;
      // Telegram once when a position NEWLY turns against (warn mode; in exit mode it already closed).
      if (s.against && !prev[ep.symbol]?.against) {
        void notifyEvent(
          "halt",
          `⚠️ <b>${ep.symbol} ${ep.pos.side}</b> ${config.monitor.reversalTf} trend reversed — guardian in <b>${config.monitor.reversalMode}</b> mode`,
        );
      }
    } catch (err) {
      // Preserve the prior status on a transient error so the alert-dedup stays correct.
      const p = prev[ep.symbol];
      if (p) status[ep.symbol] = p;
      logger.warn(`${ep.symbol}: guardian skipped this pass (${briefError(err)}); retry next pass`);
    }
  }
  setMeta(MONITOR_STATUS_KEY, JSON.stringify(status));
}

/**
 * Run the engine on a DUAL cadence:
 *   - a FULL tick (manage ladder + scan entries) a short buffer after each timeframe
 *     close — the backtest-faithful path, exactly as before, AND
 *   - a fast GUARDIAN pass every `MONITOR_INTERVAL_MIN` in between (live-only safety:
 *     enforce stops + faster-TF reversal). One process, one loop → no DB concurrency.
 * Tick/guardian failures are logged and swallowed so the loop survives API blips.
 */
export async function runScheduled(
  broker: Broker,
  deps: EngineDeps,
  opts: { settleBufferMs?: number; runImmediately?: boolean } = {},
): Promise<void> {
  const barMs = intervalMs(deps.timeframe);
  const buffer = opts.settleBufferMs ?? 15_000;
  const monitorOn = config.monitor.enabled;
  const monitorMs = Math.max(1, Math.round(config.monitor.intervalMin)) * 60_000;
  let running = true;
  const stop = () => {
    running = false;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  // The latest candle boundary we've run a FULL tick for, so each newly-closed candle
  // triggers exactly one runTick; every wake in between is a guardian pass.
  let lastCandleBoundary = Math.floor((Date.now() - buffer) / barMs) * barMs;
  if (opts.runImmediately) await safeTick(broker, deps);

  logger.info(
    `scheduler: full tick each ${deps.timeframe} close (+${Math.round(buffer / 1000)}s)` +
      (monitorOn
        ? `; guardian every ${monitorMs / 60_000}m (reversal=${config.monitor.reversalMode} on ${config.monitor.reversalTf})`
        : "; guardian OFF"),
  );

  while (running) {
    const now = Date.now();
    // The next full tick is a FIXED target (one settle buffer after the next boundary);
    // it is always a wake candidate, so a guardian wake can never skip it — even if
    // monitorMs ≥ barMs. Guardian wakes are aligned to the monitor grid in between.
    const nextTickAt = lastCandleBoundary + barMs + buffer;
    const nextMonitorAt = monitorOn ? Math.ceil((now + 1) / monitorMs) * monitorMs : Number.POSITIVE_INFINITY;
    const wakeAt = Math.min(nextTickAt, nextMonitorAt);
    setMeta("engine:nextTickTime", String(nextTickAt)); // dashboard full-tick countdown / liveness
    await sleep(Math.max(0, wakeAt - now));
    if (!running) break;

    if (Date.now() >= nextTickAt) {
      // Run the full tick once and advance to the latest closed-and-buffered boundary
      // (if the process was paused, this catches up without running a tick per missed bar).
      lastCandleBoundary = Math.floor((Date.now() - buffer) / barMs) * barMs;
      await safeTick(broker, deps);
    } else if (monitorOn) {
      await safeGuardian(broker, deps);
    }
  }
  logger.info("engine loop stopped");
}

async function safeGuardian(broker: Broker, deps: EngineDeps): Promise<void> {
  try {
    await binance.syncTime(); // signed account/order calls need a fresh clock offset
    await monitorOpenPositions(broker, deps);
  } catch (err) {
    logger.error(`guardian failed: ${briefError(err)}`);
    void notifyEvent("error", `guardian failed: ${briefError(err)}`);
  }
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
