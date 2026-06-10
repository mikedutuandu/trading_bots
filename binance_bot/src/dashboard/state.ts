import { config } from "../config.js";
import { dayKey, intervalMs } from "../util.js";
import { getClosedTrades } from "../storage/trades.js";
import { loadPositions } from "../storage/positions.js";
import { dayStartEquity, getEquityCurve, getMeta, getMetaNum } from "../storage/engineState.js";
import { metricsFromTrades, groupBy } from "../backtest/metrics.js";
import { getMarkPrices } from "../exchange/marketData.js";
import { paramsFromEnv } from "../playbooks/paramsFromEnv.js";
import { parseMonitorStatus } from "../engine/loop.js";

/** The engine's EFFECTIVE strategy knobs: prefers what the engine stamped at startup
 *  (engine:params — its env can differ from ours); falls back to OUR env (same .env)
 *  for data written before the stamp existed. `hasStamp` lets the UI mark fallbacks. */
function effectiveParams() {
  let stamped: Record<string, unknown> = {};
  try {
    stamped = JSON.parse(getMeta("engine:params") ?? "{}") as Record<string, unknown>;
  } catch {
    /* corrupt/absent stamp → fall back to env */
  }
  const fb = paramsFromEnv();
  const n = (k: string, fallback: number): number => (typeof stamped[k] === "number" ? (stamped[k] as number) : fallback);
  return {
    hasStamp: typeof stamped.adxMin === "number",
    adxMin: n("adxMin", fb.adxMin),
    atrMult: n("atrMult", fb.atrStopMult),
    take1: n("take1", fb.takeFrac1),
    take2: n("take2", fb.takeFrac2),
    trailMult: n("trailMult", fb.trailMult),
    cooldown: n("cooldown", fb.cooldownBars),
    maxHold: n("maxHold", fb.maxHoldBars),
    stall: n("stall", fb.stallBars),
    maxTotal: fb.maxTotalBars,
    maxNotional: n("maxNotional", config.risk.maxNotionalPerTrade),
    reversalMode: (stamped.reversalMode as string) ?? config.monitor.reversalMode,
    reversalTf: (stamped.reversalTf as string) ?? config.monitor.reversalTf,
    playbooks: (stamped.playbooks as string) ?? process.env.PLAYBOOKS ?? "trend-pullback",
  };
}

/** The bot's configured behaviour — so the dashboard shows WHAT it's set to do. */
function context(p: ReturnType<typeof effectiveParams>) {
  const r = config.risk;
  const { hasStamp, maxNotional } = p;
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
    playbooks: p.playbooks,
    strategy:
      `ADX≥${p.adxMin} · ATR×${p.atrMult} · TP ${p.take1}/${p.take2} · hold ${p.maxHold}/${p.stall} · ` +
      `trail ${p.trailMult}× · cd ${p.cooldown}` +
      (hasStamp ? "" : " (env — engine hasn't stamped yet)"),
    maxNotional: maxNotional > 0 ? maxNotional : null,
    guardian: `${p.reversalMode}@${p.reversalTf}`,
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
  let marksOk = true;
  if (open.length > 0) {
    try {
      marks = await getMarkPrices();
    } catch {
      marksOk = false; // venue unreachable this tick → uPnL shows —
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
  // The guardian heartbeat fires every MONITOR_INTERVAL_MIN while the process is alive —
  // it goes quiet within minutes of a dead engine, whereas nextTick (hourly) can show
  // "online" for up to ~65 min after a crash. Treat a silent guardian as STALE.
  const guardianQuiet =
    config.monitor.enabled &&
    lastMonitor !== null &&
    Date.now() - lastMonitor > Math.max(3 * config.monitor.intervalMin * 60_000, 180_000);
  // Stale = well past the scheduled next tick (process likely died). Fall back to
  // tick-age when nextTick is absent (data from before this field existed).
  const status =
    lastTick === null && nextTick === null
      ? "idle"
      : guardianQuiet
        ? "stale"
        : nextTick !== null
          ? Date.now() > nextTick + 5 * 60_000
            ? "stale"
            : "online"
          : ageMs! > 2 * barMs + 5 * 60_000
            ? "stale"
            : "online";

  // Kill-switch proximity: the engine halts NEW entries past −MAX_DAILY_LOSS_PCT from the
  // day's opening equity. Surfaces "how close are we to the breaker" (snapshot-based —
  // live float not included, same basis the engine itself uses at tick time).
  const dayOpen = dayStartEquity(Date.now(), latestEquity);
  const dayDdPct = dayOpen > 0 ? Math.max(0, (dayOpen - latestEquity) / dayOpen) : 0;

  const params = effectiveParams();
  const openPositions = open.map((p) => {
    const mark = marks.get(p.symbol) ?? null;
    const sign = p.pos.side === "long" ? 1 : -1;
    // Live mark-to-market on the remaining qty (matches Binance's Unrealized PNL).
    const unrealizedPnl = mark === null ? null : sign * (mark - p.pos.entry) * p.pos.qtyRemaining;
    // Time-stop progress, counted EXACTLY like the engine: closed bars between the
    // signal candle's open and the last PROCESSED candle's open (evaluated hourly —
    // so a "12-bar" limit closes at ~13h of wall-clock Age, not 12h).
    const heldBars = lastTick !== null ? Math.max(0, Math.round((lastTick - p.openedAtBarTime) / barMs)) : null;
    const holdLimit = p.pos.tp2Hit
      ? params.maxTotal > 0
        ? params.maxTotal
        : null
      : p.pos.tp1Hit
        ? params.stall > 0
          ? params.stall
          : null
        : params.maxHold > 0
          ? params.maxHold
          : null;
    return {
      heldBars,
      holdLimit, // bars until the applicable time-stop (maxHold pre-TP1 / stall pre-TP2 / maxTotal), null = off
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
      qtyTp1: p.pos.qtyTp1, // 0 under TAKE1=0 → "TP1 hit" only means breakeven armed
      tp1Hit: p.pos.tp1Hit,
      tp2Hit: p.pos.tp2Hit,
      riskUsdt: p.riskUsdt,
      // Gap-through-stop loss scales with NOTIONAL — the number the $500 cap bounds.
      notional: (mark ?? p.pos.entry) * p.pos.qtyRemaining,
      unrealizedPnl, // live float on the remaining leg
      realizedSoFar: p.grossPnl - p.commission + p.funding, // booked (fees + partial TPs)
      monitor: monitorStatus[p.symbol] ?? null, // guardian's faster-TF status {up, against} or null
      openedAt: p.openedAt,
    };
  });
  // Sum of live floating PnL across open positions (separate from realized metrics).
  // null when the mark fetch failed — "unknown" must not render as a green +0.00.
  const unrealizedPnl = marksOk ? openPositions.reduce((s, o) => s + (o.unrealizedPnl ?? 0), 0) : null;
  const grossExposure = openPositions.reduce((s, o) => s + o.notional, 0);

  return {
    now: Date.now(),
    timeframe: config.strategy.timeframe,
    venue: getMeta("engine:label") ?? "—", // TESTNET | LIVE — which run wrote this data
    context: context(params),
    today: { trades: todays.length, netPnl: todayPnl },
    unrealizedPnl, // live floating PnL of open positions (null = marks unavailable)
    grossExposure, // Σ |notional| of open positions — what a gap actually hits
    kill: { dayOpen, ddPct: dayDdPct, limitPct: config.risk.maxDailyLossPct },
    health: { lastTick, ageMs, nextTick, nextInMs, status, lastMonitor },
    metrics,
    open: openPositions,
    byPlaybook,
    byReason: [...groupBy(closed, (t) => t.closeReason ?? "?")].map(([k, g]) => ({
      reason: k,
      trades: g.trades,
      winRate: g.trades ? g.wins / g.trades : 0,
      netPnl: g.netPnl,
    })),
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
