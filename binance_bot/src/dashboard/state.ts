import { config } from "../config.js";
import { dayKey } from "../util.js";
import { getClosedTrades } from "../storage/trades.js";
import { loadPositions } from "../storage/positions.js";
import { getEquityCurve, getMeta, getMetaNum } from "../storage/engineState.js";
import { metricsFromTrades, groupBy } from "../backtest/metrics.js";
import { getMarkPrices } from "../exchange/marketData.js";
import { intervalMs, parseMonitorStatus } from "../engine/loop.js";

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
export async function buildState(windowMs?: number) {
  // Time window: when set, the stats / equity chart / closed table reflect only the
  // last `windowMs` (open positions, live equity & health stay current). Reuses the
  // same metrics code as the all-time view — just over a filtered slice.
  const cutoff = windowMs && windowMs > 0 ? Date.now() - windowMs : 0;
  const allClosed = getClosedTrades();
  const allCurve = getEquityCurve();
  const closed = cutoff ? allClosed.filter((t) => (t.closedAt ?? 0) >= cutoff) : allClosed;
  const curve = cutoff ? allCurve.filter((c) => c.ts >= cutoff) : allCurve;
  const open = loadPositions();

  // Live mark prices in ONE best-effort call → real-time unrealized PnL. If the venue
  // is unreachable this tick we just skip marks (uPnL shows "—"); the next poll retries.
  let marks = new Map<string, number>();
  if (open.length > 0) {
    try {
      marks = await getMarkPrices();
    } catch {
      /* venue unreachable this tick → uPnL shows — */
    }
  }

  // Fall back to the all-time tail so the Equity KPI always shows CURRENT equity even
  // if the chosen window has no snapshots yet.
  const latestEquity = allCurve[allCurve.length - 1]?.equity ?? 0;
  const startEquity = curve[0]?.equity ?? latestEquity;
  const endEquity = curve[curve.length - 1]?.equity ?? latestEquity;
  const metrics = metricsFromTrades(closed, curve, startEquity, endEquity);

  const byPlaybook = [...groupBy(closed, (t) => t.playbook)].map(([k, g]) => ({
    playbook: k,
    trades: g.trades,
    winRate: g.trades ? g.wins / g.trades : 0,
    netPnl: g.netPnl,
  }));

  // Today's pulse: trades closed today (UTC) — always the calendar day, independent of the window.
  const today = dayKey(Date.now());
  const todays = allClosed.filter((t) => t.closedAt && dayKey(t.closedAt) === today);
  const todayPnl = todays.reduce((s, t) => s + (t.netPnl ?? 0), 0);

  // Health: how fresh is the last tick, and when is the next one scheduled?
  const lastTick = getMetaNum("engine:lastTickTime");
  const nextTick = getMetaNum("engine:nextTickTime");
  const lastMonitor = getMetaNum("engine:lastMonitorTime");
  const monitorStatus = parseMonitorStatus(getMeta("monitor:status"));
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
      monitor: monitorStatus[p.symbol] ?? null, // guardian's faster-TF status {up, against} or null
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
    health: { lastTick, ageMs, nextTick, nextInMs, status, lastMonitor },
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
