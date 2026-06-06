import { config } from "../config.js";
import { dayKey } from "../util.js";
import { getClosedTrades } from "../storage/trades.js";
import { loadPositions } from "../storage/positions.js";
import { getEquityCurve, getMeta, getMetaNum } from "../storage/engineState.js";
import { metricsFromTrades, groupBy } from "../backtest/metrics.js";
import { getMarkPrice } from "../exchange/marketData.js";
import { paramsFromEnv } from "../playbooks/paramsFromEnv.js";
import { intervalMs } from "../engine/loop.js";

/** The lifecycle timeout that fires FIRST for a position in its current state
 *  (pre-TP1 → maxHold, TP1→TP2 → stall, plus the global cap), or null if all are
 *  disabled. Mirrors the partition in manageOnCandle (every tier gated on > 0). */
function activeTimeout(
  tp1Hit: boolean,
  tp2Hit: boolean,
  p: { maxHoldBars: number; stallBars: number; maxTotalBars: number },
): { stage: 1 | 2 | 3; bars: number } | null {
  const tiers: Array<{ stage: 1 | 2 | 3; bars: number }> = [];
  if (!tp1Hit && p.maxHoldBars > 0) tiers.push({ stage: 1, bars: p.maxHoldBars });
  if (tp1Hit && !tp2Hit && p.stallBars > 0) tiers.push({ stage: 2, bars: p.stallBars });
  if (p.maxTotalBars > 0) tiers.push({ stage: 3, bars: p.maxTotalBars });
  if (!tiers.length) return null;
  return tiers.reduce((a, b) => (b.bars < a.bars ? b : a));
}

/** The bot's configured behaviour — so the dashboard shows WHAT it's set to do. */
function context() {
  const r = config.risk;
  return {
    risk: r.riskUsdt > 0 ? `${r.riskUsdt} USDT` : `${(r.riskPct * 100).toFixed(2)}%`,
    leverage: r.leverage,
    maxOpen: r.maxOpenPositions,
    killSwitchPct: r.maxDailyLossPct,
    timeframe: config.strategy.timeframe,
    universe:
      config.universe.mode === "static"
        ? `${config.universe.symbols.length} static`
        : `top ${config.universe.size} dynamic`,
    playbooks: process.env.PLAYBOOKS ?? "trend-pullback",
  };
}

/** A full read-only snapshot of bot state for the dashboard. Trades/equity come
 *  from SQLite; live mark prices for OPEN positions are fetched from the venue
 *  (public, best-effort) so unrealized PnL is real-time like the Binance UI. */
export async function buildState() {
  const closed = getClosedTrades();
  const curve = getEquityCurve();
  const open = loadPositions();

  // Live mark price per open symbol → real-time unrealized PnL (best-effort).
  const marks = new Map<string, number>();
  await Promise.all(
    open.map(async (p) => {
      try {
        marks.set(p.symbol, (await getMarkPrice(p.symbol)).markPrice);
      } catch {
        /* leave unset → uPnL shows as — */
      }
    }),
  );

  const startEquity = curve[0]?.equity ?? 0;
  const endEquity = curve[curve.length - 1]?.equity ?? startEquity;
  const metrics = metricsFromTrades(closed, curve, startEquity, endEquity);

  const byPlaybook = [...groupBy(closed, (t) => t.playbook)].map(([k, g]) => ({
    playbook: k,
    trades: g.trades,
    winRate: g.trades ? g.wins / g.trades : 0,
    netPnl: g.netPnl,
  }));

  // Today's pulse: trades closed today (UTC) and their net PnL.
  const today = dayKey(Date.now());
  const todays = closed.filter((t) => t.closedAt && dayKey(t.closedAt) === today);
  const todayPnl = todays.reduce((s, t) => s + (t.netPnl ?? 0), 0);

  // Health: how fresh is the last tick, and when is the next one scheduled?
  const params = paramsFromEnv();
  const lastTick = getMetaNum("engine:lastTickTime");
  const nextTick = getMetaNum("engine:nextTickTime");
  const barMs = intervalMs(config.strategy.timeframe);
  const ageMs = lastTick ? Date.now() - lastTick : null;
  const nextInMs = nextTick ? nextTick - Date.now() : null;
  // Stale = well past the scheduled next tick (process likely died). Fall back to
  // tick-age when nextTick is absent (data from before this field existed).
  const status =
    lastTick === null && nextTick === null
      ? "idle"
      : nextTick !== null
        ? Date.now() > nextTick + 5 * 60_000
          ? "stale"
          : "online"
        : ageMs! > 2 * barMs + 5 * 60_000
          ? "stale"
          : "online";

  const openPositions = open.map((p) => {
    const mark = marks.get(p.symbol) ?? null;
    const sign = p.pos.side === "long" ? 1 : -1;
    // Live mark-to-market on the remaining qty (matches Binance's Unrealized PNL).
    const unrealizedPnl = mark === null ? null : sign * (mark - p.pos.entry) * p.pos.qtyRemaining;
    // Which lifecycle timeout will fire first, and how long until it does.
    const to = activeTimeout(p.pos.tp1Hit, p.pos.tp2Hit, params);
    const timeout = to
      ? { stage: to.stage, limitMs: to.bars * barMs, leftMs: to.bars * barMs - (Date.now() - p.openedAt) }
      : null;
    return {
      symbol: p.symbol,
      side: p.pos.side,
      playbook: p.playbook,
      entry: p.pos.entry,
      markPrice: mark,
      stop: p.pos.stop,
      tp1: p.pos.tp1,
      tp2: p.pos.tp2,
      qtyRemaining: p.pos.qtyRemaining,
      qtyTotal: p.pos.qtyTotal,
      tp1Hit: p.pos.tp1Hit,
      tp2Hit: p.pos.tp2Hit,
      riskUsdt: p.riskUsdt,
      unrealizedPnl, // live
      realizedSoFar: p.grossPnl - p.commission + p.funding, // booked (fees + partial TPs)
      timeout, // active lifecycle timeout {stage, limitMs, leftMs} or null
      openedAt: p.openedAt,
    };
  });
  // Sum of live floating PnL across open positions (separate from realized metrics).
  const unrealizedPnl = openPositions.reduce((s, o) => s + (o.unrealizedPnl ?? 0), 0);

  return {
    now: Date.now(),
    timeframe: config.strategy.timeframe,
    venue: getMeta("engine:label") ?? "—", // TESTNET | LIVE — which run wrote this data
    context: context(),
    today: { trades: todays.length, netPnl: todayPnl },
    unrealizedPnl, // live floating PnL of open positions
    health: { lastTick, ageMs, nextTick, nextInMs, status },
    metrics,
    open: openPositions,
    byPlaybook,
    equityCurve: curve.map((c) => ({ ts: c.ts, equity: c.equity })),
    recentClosed: closed
      .slice(-50)
      .reverse()
      .map((t) => ({
        symbol: t.symbol,
        side: t.side,
        playbook: t.playbook,
        closeReason: t.closeReason,
        rRealized: t.rRealized,
        netPnl: t.netPnl,
        openedAt: t.openedAt,
        closedAt: t.closedAt,
      })),
  };
}

export type DashboardState = Awaited<ReturnType<typeof buildState>>;
