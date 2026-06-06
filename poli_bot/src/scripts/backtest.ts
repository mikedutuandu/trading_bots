/**
 * Backtest the strategy against logged ticks in ./data/ticks.sqlite.
 *
 * Replays each tick in order, computes a fresh fair-value vs the recorded BTC
 * snapshot, runs `decide(...)`, and simulates trades against the recorded best ask.
 * At each window's close it matches against the recorded outcome.
 */
import Database from "better-sqlite3";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { fairValue, blendWithMarket } from "../analysis/fairvalue.js";
import { decide } from "../strategy/signal.js";
import { kellyRiskUsd } from "../strategy/sizing.js";
import { RollingRealizedVol } from "../btc/volatility.js";

const STRATEGY = {
  ...config.strategy,
  maxRiskFraction: config.risk.maxRiskPerTradeUsd / config.strategy.bankrollUsd,
  takerFee: 0.02,
} as const;

interface TickRow {
  ts: number;
  window_start_ms: number;
  window_end_ms: number;
  market_slug: string;
  up_best_bid: number | null;
  up_best_ask: number | null;
  up_mid: number | null;
  down_best_bid: number | null;
  down_best_ask: number | null;
  down_mid: number | null;
  btc_price: number;
  btc_price_at_window_start: number | null;
  realized_vol_1m: number | null;
}

interface OutcomeRow {
  window_end_ts: number;
  market_slug: string;
  btc_price_open: number | null;
  btc_price_close: number | null;
  outcome_up: number | null;            // bot's Binance guess
  polymarket_outcome_up: number | null; // ground truth (preferred)
}

interface SimTrade {
  windowEndMs: number;
  slug: string;
  side: "UP" | "DOWN";
  takerPrice: number;
  riskUsd: number;
  edge: number;
  fairValueUp: number;
}

function main(): void {
  const db = new Database(config.collector.dbPath, { readonly: true });
  const ticks = db.prepare(`SELECT * FROM ticks ORDER BY ts ASC`).all() as TickRow[];
  const outcomes = new Map<number, OutcomeRow>();
  for (const r of db.prepare(`SELECT * FROM window_outcomes`).all() as OutcomeRow[]) {
    outcomes.set(r.window_end_ts, r);
  }
  logger.info(`Loaded ${ticks.length} ticks, ${outcomes.size} window outcomes`);

  const tradedWindows = new Set<number>();
  const trades: SimTrade[] = [];
  // Reconstruct the live ~30-min rolling drift by replaying every tick through the SAME
  // class the live bot uses (RollingRealizedVol). This is the trend signal the trend-agreement
  // filter keys off — and it differs from the within-window spot-vs-strike trend, so the old
  // spot/strike proxy was NOT a faithful stand-in. Push every tick (even non-tradeable ones)
  // so the drift history is continuous, matching how the live feed accumulates.
  const rv = new RollingRealizedVol(30);

  for (const t of ticks) {
    rv.push(t.ts, t.btc_price);
    const driftLive = rv.annualizedDrift() ?? 0;
    if (tradedWindows.has(t.window_end_ms)) continue;
    if (t.btc_price_at_window_start === null || t.realized_vol_1m === null) continue;
    if (t.up_best_ask === null || t.down_best_ask === null) continue;
    const remainingSec = Math.max(0, (t.window_end_ms - t.ts) / 1000);
    const fvRaw = fairValue({
      spot: t.btc_price,
      strike: t.btc_price_at_window_start,
      remainingSeconds: remainingSec,
      annualizedVol: t.realized_vol_1m,
      // Live hardcodes drift=0 in fair value (the 30-min estimate is too noisy for pricing);
      // match that here. The rolling drift is used only as the trend-filter signal below.
      drift: 0,
    });
    if (!fvRaw) continue;
    const upQuotes = { bestBid: t.up_best_bid, bestAsk: t.up_best_ask, mid: t.up_mid, spread: t.up_best_bid !== null && t.up_best_ask !== null ? t.up_best_ask - t.up_best_bid : null };
    const downQuotes = { bestBid: t.down_best_bid, bestAsk: t.down_best_ask, mid: t.down_mid, spread: t.down_best_bid !== null && t.down_best_ask !== null ? t.down_best_ask - t.down_best_bid : null };
    const fv = blendWithMarket(fvRaw, upQuotes.mid, STRATEGY.marketWeight);
    const decision = decide({
      fair: fv,
      upQuotes,
      downQuotes,
      minEdge: STRATEGY.minEdge,
      maxSpread: STRATEGY.maxSpread,
      minRemainingSec: STRATEGY.minRemainingSec,
      maxRemainingSec: STRATEGY.maxRemainingSec,
      remainingSec,
      spot: t.btc_price,
      strike: t.btc_price_at_window_start,
      annualizedDrift: driftLive,
      maxVol: STRATEGY.maxVol,
      annualizedVol: t.realized_vol_1m,
      upOnly: STRATEGY.upOnly,
      minFvUp: STRATEGY.minFvUp,
      maxEdge: STRATEGY.maxEdge,
      minEntryPrice: STRATEGY.minEntryPrice,
      maxEntryPrice: STRATEGY.maxEntryPrice,
      maxBtcMovedPct: STRATEGY.maxBtcMovedPct,
      minBtcMovedPct: STRATEGY.minBtcMovedPct,
      requireTrendAgreement: STRATEGY.requireTrendAgreement,
    });
    if (!decision.side || decision.takerPrice === null) continue;
    const riskUsd = kellyRiskUsd({
      bankrollUsd: STRATEGY.bankrollUsd,
      edge: decision.edge,
      takerPrice: decision.takerPrice,
      maxRiskFraction: STRATEGY.maxRiskFraction,
      kellyFraction: STRATEGY.kellyFraction,
    });
    if (riskUsd < 1) continue;
    trades.push({
      windowEndMs: t.window_end_ms,
      slug: t.market_slug,
      side: decision.side,
      takerPrice: decision.takerPrice,
      riskUsd,
      edge: decision.edge,
      fairValueUp: fv.pUp,
    });
    tradedWindows.add(t.window_end_ms);
  }

  // Resolve against Polymarket's outcome when available; fall back to Binance guess otherwise.
  let wins = 0;
  let totalPnl = 0;
  let totalRisk = 0;
  let resolvedFromPolymarket = 0;
  let resolvedFromBinance = 0;
  let disagreements = 0;
  const skippedNoOutcome: string[] = [];
  for (const tr of trades) {
    const o = outcomes.get(Math.floor(tr.windowEndMs / 1000));
    if (!o) { skippedNoOutcome.push(tr.slug); continue; }

    let upWon: boolean | null = null;
    let source: "polymarket" | "binance" = "binance";
    if (o.polymarket_outcome_up !== null && o.polymarket_outcome_up !== undefined) {
      upWon = o.polymarket_outcome_up === 1;
      source = "polymarket";
    } else if (o.outcome_up !== null) {
      upWon = o.outcome_up === 1;
      source = "binance";
    }
    if (upWon === null) { skippedNoOutcome.push(tr.slug); continue; }
    if (source === "polymarket") resolvedFromPolymarket++; else resolvedFromBinance++;

    // Track when the two sources disagree
    if (o.polymarket_outcome_up !== null && o.outcome_up !== null &&
        o.polymarket_outcome_up !== o.outcome_up) {
      disagreements++;
    }

    const win = (tr.side === "UP" && upWon) || (tr.side === "DOWN" && !upWon);
    const shares = tr.riskUsd / tr.takerPrice;
    const fees = tr.riskUsd * STRATEGY.takerFee;
    const pnl = (win ? 1 : 0) * shares - shares * tr.takerPrice - fees;
    if (win) wins++;
    totalPnl += pnl;
    totalRisk += tr.riskUsd;
  }
  const resolved = trades.length - skippedNoOutcome.length;
  const winRate = resolved > 0 ? wins / resolved : 0;
  const roi = totalRisk > 0 ? totalPnl / totalRisk : 0;

  logger.info("Backtest result", {
    trades: trades.length,
    resolved,
    resolvedFromPolymarket,
    resolvedFromBinance,
    skippedNoOutcome: skippedNoOutcome.length,
    binanceVsPolymarketDisagreements: disagreements,
    wins,
    winRate: (winRate * 100).toFixed(1) + "%",
    totalRiskUsd: totalRisk.toFixed(2),
    totalPnlUsd: totalPnl.toFixed(2),
    roi: (roi * 100).toFixed(2) + "%",
  });
}

main();
