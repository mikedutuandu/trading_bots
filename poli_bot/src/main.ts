import { config } from "./config.js";
import { logger } from "./logger.js";
import { BinanceBtcFeed } from "./btc/binance-ws.js";
import { ChainlinkBtcFeed } from "./btc/chainlink-ws.js";
import type { BtcPriceFeed } from "./btc/feed.js";
import { RollingRealizedVol } from "./btc/volatility.js";
import { findActiveBtc5mEvents, pickCurrentBtc5m, fetchSettledOutcome } from "./polymarket/gamma.js";
import { getOrderBook, bestQuotes, type BestQuotes } from "./polymarket/clob.js";
import { TickStore, type LiveTradeRow } from "./storage/db.js";
import { fairValue, blendWithMarket } from "./analysis/fairvalue.js";
import { decide } from "./strategy/signal.js";
import { kellyRiskUsd } from "./strategy/sizing.js";
import { RiskManager } from "./execution/risk.js";
import { PaperTrader } from "./execution/paper.js";
import { LiveTrader } from "./execution/live.js";
import { TelegramNotifier } from "./notifications/telegram.js";
import { sideWins, type BtcUpDownEvent, type Side } from "./types.js";

const STRATEGY = config.strategy;
const RISK_LIMITS = { bankrollUsd: STRATEGY.bankrollUsd, ...config.risk };

interface SettlementUpdate {
  status: "FILLED" | "PARTIAL" | "CANCELLED";
  filledShares: number;
  avgFillPrice: number;
  polymarketOutcomeUp: 0 | 1 | null;
  realizedPnlUsd: number;
  btcPriceAtClose: number | null;
}

async function computeSettlement(
  row: Pick<LiveTradeRow, "id" | "order_id" | "side" | "limit_price" | "requested_shares">,
  upWon: boolean,
  polyUp: 0 | 1 | null,
  btcPriceAtClose: number | null,
  liveTrader: LiveTrader,
): Promise<SettlementUpdate> {
  let filled = 0;
  let avgPrice = row.limit_price;
  let status: SettlementUpdate["status"] = "CANCELLED";

  if (row.order_id?.startsWith("dry-")) {
    filled = row.requested_shares;
    status = "FILLED";
  } else if (row.order_id) {
    try {
      const info = await liveTrader.getOrder(row.order_id) as { status?: string; size_matched?: string; price?: string } | null;
      filled = Number(info?.size_matched ?? 0);
      avgPrice = Number(info?.price ?? row.limit_price);
      status = filled >= row.requested_shares - 1e-6 ? "FILLED" : filled > 0 ? "PARTIAL" : "CANCELLED";
    } catch (err) {
      logger.debug("getOrder failed during settlement", { id: row.id, err: (err as Error).message });
    }
  }

  const win = sideWins(row.side, upWon);
  const pnl = (win ? 1 : 0) * filled - filled * avgPrice;
  return { status, filledShares: filled, avgFillPrice: avgPrice, polymarketOutcomeUp: polyUp, realizedPnlUsd: pnl, btcPriceAtClose };
}

async function main(): Promise<void> {
  logger.info("Starting trading bot");
  logger.info("Strategy params:", STRATEGY);
  logger.info("Risk limits:", RISK_LIMITS);
  logger.info("Live trading:", { enabled: config.live.enabled, dryRun: config.live.dryRun, maxTradeUsd: config.live.maxTradeUsd });

  const store = new TickStore(config.collector.dbPath);
  const feed: BtcPriceFeed = config.priceSource === "binance"
    ? new BinanceBtcFeed()
    : new ChainlinkBtcFeed();
  logger.info(`BTC price source: ${config.priceSource}`);
  const vol = new RollingRealizedVol(30);
  const risk = new RiskManager(RISK_LIMITS);
  const paper = new PaperTrader(risk);
  const liveTrader = new LiveTrader();
  const telegram = new TelegramNotifier();
  const liveOrdersInFlight = new Set<string>();
  const state: {
    events: BtcUpDownEvent[];
    currentEvent: BtcUpDownEvent | null;
    windowOpenBtcPrice: number | null;
  } = { events: [], currentEvent: null, windowOpenBtcPrice: null };

  async function settleOne(row: LiveTradeRow): Promise<"settled" | "not_yet" | "failed"> {
    try {
      const outcome = await fetchSettledOutcome(row.market_slug);
      if (outcome === null) return "not_yet";
      const upWon = outcome === "UP";
      const polyUp: 0 | 1 | null = outcome === "UP" ? 1 : outcome === "DOWN" ? 0 : null;
      const btcAtClose = feed.getLast().price || null;
      const update = await computeSettlement(row, upWon, polyUp, btcAtClose, liveTrader);
      store.updateLiveTradeSettled(row.id, { ...update, feesUsd: 0, closedAtMs: Date.now() });
      logger.info("live SETTLED", {
        id: row.id, slug: row.market_slug, side: row.side, outcome,
        status: update.status, filled: update.filledShares.toFixed(2), pnl: update.realizedPnlUsd.toFixed(2),
      });
      const win = sideWins(row.side, upWon);
      const emoji = win ? "✅" : "❌";
      telegram.fireAndForget([
        `${emoji} *Live trade settled*`,
        `Side: *${row.side}* @ \`$${row.limit_price}\``,
        `Outcome: *${outcome}* → ${win ? "WIN" : "LOSS"}`,
        `P&L: \`${update.realizedPnlUsd >= 0 ? "+" : ""}$${update.realizedPnlUsd.toFixed(2)}\``,
      ].join("\n"));
      return "settled";
    } catch (err) {
      logger.warn("settleOne failed", { id: row.id, err: (err as Error).message });
      return "failed";
    }
  }

  async function reconcileOrphans(thresholdMs = Date.now(), quiet = false): Promise<void> {
    if (!config.live.enabled || !liveTrader.isInitialized()) return;
    const orphans = store.findUnsettledLiveTrades(thresholdMs);
    if (orphans.length === 0) return;
    const results = await Promise.all(orphans.map(async (o) => ({ o, result: await settleOne(o) })));
    const settled = results.filter((r) => r.result === "settled");
    const stillPending = results.length - settled.length;
    if (settled.length > 0) {
      logger.info(`Reconcile: ${settled.length} settled, ${stillPending} still pending`);
    } else if (!quiet) {
      logger.debug(`Reconcile: ${stillPending} still pending`);
    }
  }

  async function settleLiveTradesForWindow(windowEndMs: number, upWon: boolean, polyUp: 0 | 1): Promise<void> {
    if (!config.live.enabled || !liveTrader.isInitialized()) return;
    const rows = store.findPlacedLiveTradesByWindow(Math.floor(windowEndMs / 1000));
    const btcAtClose = feed.getLast().price || null;
    for (const r of rows) {
      try {
        const update = await computeSettlement(r, upWon, polyUp, btcAtClose, liveTrader);
        store.updateLiveTradeSettled(r.id, { ...update, feesUsd: 0, closedAtMs: Date.now() });
        logger.info("live CLOSE", { id: r.id, side: r.side, status: update.status, pnl: update.realizedPnlUsd.toFixed(2) });
        const win = sideWins(r.side, upWon);
        const emoji = win ? "✅" : "❌";
        telegram.fireAndForget([
          `${emoji} *Live trade settled*`,
          `Side: *${r.side}* @ \`$${r.limit_price}\``,
          `Outcome: *${upWon ? "UP" : "DOWN"}* → ${win ? "WIN" : "LOSS"}`,
          `Status: ${update.status} (${update.filledShares.toFixed(2)} shares filled)`,
          `P&L: \`${update.realizedPnlUsd >= 0 ? "+" : ""}$${update.realizedPnlUsd.toFixed(2)}\``,
        ].join("\n"));
      } catch (err) {
        logger.warn("live settlement failed", { id: r.id, error: (err as Error).message });
      }
    }
  }

  if (config.live.enabled) {
    try {
      const ok = await liveTrader.init();
      if (ok) {
        const bal = await liveTrader.getCollateralBalance();
        logger.info("LiveTrader ready", { address: liveTrader.getAddress(), pUsdBalance: bal.collateralBalanceUsd, dryRun: liveTrader.isDryRun() });
        if (bal.collateralBalanceUsd < config.live.maxTradeUsd) {
          logger.warn(`pUSD balance ${bal.collateralBalanceUsd} is below LIVE_MAX_TRADE_USD ${config.live.maxTradeUsd}. Did you wrap USDC to pUSD via polymarket.com?`);
        }
        await reconcilePendingLiveTrades();
        await reconcileOrphans();
      }
    } catch (err) {
      logger.error("LiveTrader init failed — continuing in paper-only mode:", (err as Error).message);
    }
  }

  feed.onTick((t) => vol.push(t.ts, t.price));
  feed.start();

  async function refreshEvents(): Promise<void> {
    try {
      state.events = await findActiveBtc5mEvents();
      logger.debug(`Active upcoming BTC 5m events: ${state.events.length}`);
    } catch (err) {
      logger.warn("refreshEvents failed", (err as Error).message);
    }
  }

  async function awaitPolymarketSettlement(prev: BtcUpDownEvent, btcOpen: number): Promise<void> {
    const windowEndTs = Math.floor(prev.windowEndMs / 1000);
    for (let attempt = 0; attempt < config.collector.settlementPollAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, config.collector.settlementPollMs));
      try {
        const outcome = await fetchSettledOutcome(prev.slug);
        if (outcome === null) continue;
        const polyUp: 0 | 1 | null = outcome === "UP" ? 1 : outcome === "DOWN" ? 0 : null;
        store.recordPolymarketOutcome(windowEndTs, polyUp);

        if (outcome === "TIE") {
          logger.info("Polymarket TIE — discarding paper trades", { slug: prev.slug });
          paper.resolveWindow(prev.windowEndMs, prev.slug, false);
          return;
        }
        const upWon = outcome === "UP";
        const settled = paper.resolveWindow(prev.windowEndMs, prev.slug, upWon);
        const btcAtClose = feed.getLast().price || null;
        for (const r of settled) {
          store.recordPaperTrade({
            windowEndTs, marketSlug: r.position.marketSlug, side: r.position.side,
            enteredAtMs: r.position.enteredAt, takerPrice: r.position.takerPrice,
            shares: r.position.shares, riskUsd: r.position.riskUsd, feesUsd: r.position.feesUsd,
            fairValueUp: r.position.context.fairValueUp,
            edge: r.position.context.edge,
            closePrice: r.closePrice,
            realizedPnlUsd: r.realizedPnlUsd, win: r.win ? 1 : 0,
            btcPriceAtEntry: r.position.context.btcPriceAtEntry,
            btcStrike: r.position.context.btcStrike,
            remainingSecAtEntry: r.position.context.remainingSecAtEntry,
            realizedVolAtEntry: r.position.context.realizedVolAtEntry,
            driftAtEntry: r.position.context.driftAtEntry,
            upBestBidAtEntry: r.position.context.upBestBidAtEntry,
            upBestAskAtEntry: r.position.context.upBestAskAtEntry,
            downBestBidAtEntry: r.position.context.downBestBidAtEntry,
            downBestAskAtEntry: r.position.context.downBestAskAtEntry,
            btcPriceAtClose: btcAtClose,
            strategyConfig: r.position.context.strategyConfig,
            btcPriceSource: r.position.context.btcPriceSource,
            kellyRecommendedRiskUsd: r.position.context.kellyRecommendedRiskUsd,
          });
        }
        const localBtcUp = (feed.getLast().price || btcOpen) > btcOpen;
        logger.info("Polymarket settled", {
          slug: prev.slug,
          polymarketOutcome: outcome,
          localGuess: localBtcUp ? "UP" : "DOWN",
          agreement: localBtcUp === upWon ? "✓" : `✗ DISAGREES with local ${config.priceSource} feed`,
          paperSettled: settled.length,
        });
        await settleLiveTradesForWindow(prev.windowEndMs, upWon, polyUp!);
        return;
      } catch (err) {
        logger.debug("settlement poll failed, retrying", (err as Error).message);
      }
    }
    logger.warn("Polymarket settlement timed out", { slug: prev.slug });
  }

  function rolloverIfNeeded(nowMs: number): void {
    const prev = state.currentEvent;
    const current = pickCurrentBtc5m(state.events, nowMs);
    if (current?.slug === prev?.slug) return;

    if (prev && state.windowOpenBtcPrice !== null) {
      const close = feed.getLast().price;
      if (close > 0) {
        store.recordOutcome(Math.floor(prev.windowEndMs / 1000), prev.slug, state.windowOpenBtcPrice, close);
        logger.info("Window closed", {
          slug: prev.slug,
          priceSource: config.priceSource,
          open: state.windowOpenBtcPrice,
          close,
          guess: close > state.windowOpenBtcPrice ? "UP" : "DOWN",
        });
        void awaitPolymarketSettlement(prev, state.windowOpenBtcPrice);
      }
    }
    state.currentEvent = current;
    if (current) {
      // On a normal in-process rollover the window just started, so there are no prior
      // ticks for it and we capture the live spot as the open. On a mid-window restart
      // the previous run already recorded the true window-open price — recover it from
      // the DB so we don't reset the strike to the restart-moment spot (which would
      // zero out priceTrend and defeat the maxBtcMovedPct / blockAgainstTrend guards).
      const recovered = store.recoverWindowOpenPrice(current.slug);
      state.windowOpenBtcPrice = recovered ?? (feed.getLast().price || null);
      logger.info("New window", {
        slug: current.slug,
        end: new Date(current.windowEndMs).toISOString(),
        open: state.windowOpenBtcPrice,
        openSource: recovered !== null ? "recovered-from-db" : "live-spot",
      });
    } else {
      state.windowOpenBtcPrice = null;
    }
  }

  async function placeLiveOrder(opts: {
    tokenId: string; conditionId: string | null; side: Side; price: number; size: number;
    windowEndMs: number; marketSlug: string; nowMs: number;
    fairValueUp: number | null;
    edge: number | null;
    btcPriceAtEntry: number | null;
    btcStrike: number | null;
    remainingSecAtEntry: number | null;
    realizedVolAtEntry: number | null;
    driftAtEntry: number | null;
    upBestBidAtEntry: number | null;
    upBestAskAtEntry: number | null;
    downBestBidAtEntry: number | null;
    downBestAskAtEntry: number | null;
    strategyConfig: string | null;
    btcPriceSource: string | null;
    kellyRecommendedRiskUsd: number | null;
  }): Promise<void> {
    const actualRiskUsd = opts.size * opts.price;
    // Reserve the row as PENDING *before* the network call. This synchronous write closes
    // the restart race: if we die during placeBuy, the row is already on disk and the slug
    // dedup blocks a duplicate. reconcilePendingLiveTrades resolves it on the next boot.
    const rowId = store.recordLiveOrderPending({
      windowEndTs: Math.floor(opts.windowEndMs / 1000),
      marketSlug: opts.marketSlug, tokenId: opts.tokenId, conditionId: opts.conditionId, side: opts.side,
      limitPrice: opts.price, requestedShares: opts.size, riskUsd: actualRiskUsd, placedAtMs: opts.nowMs,
      fairValueUp: opts.fairValueUp,
      edge: opts.edge,
      btcPriceAtEntry: opts.btcPriceAtEntry,
      btcStrike: opts.btcStrike,
      remainingSecAtEntry: opts.remainingSecAtEntry,
      realizedVolAtEntry: opts.realizedVolAtEntry,
      driftAtEntry: opts.driftAtEntry,
      upBestBidAtEntry: opts.upBestBidAtEntry,
      upBestAskAtEntry: opts.upBestAskAtEntry,
      downBestBidAtEntry: opts.downBestBidAtEntry,
      downBestAskAtEntry: opts.downBestAskAtEntry,
      strategyConfig: opts.strategyConfig,
      btcPriceSource: opts.btcPriceSource,
      kellyRecommendedRiskUsd: opts.kellyRecommendedRiskUsd,
    });
    const result = await liveTrader.placeBuy({ tokenId: opts.tokenId, side: opts.side, price: opts.price, size: opts.size });
    store.finalizeLiveOrder(rowId, {
      status: result.ok ? "PLACED" : "FAILED",
      orderId: result.ok ? result.orderId ?? null : null,
      error: result.ok ? null : result.error ?? null,
    });
    if (result.ok) {
      telegram.fireAndForget([
        `🎯 *LIVE BUY placed*`,
        `Side: *${opts.side}* @ \`$${opts.price}\``,
        `Size: ${opts.size} shares ($${actualRiskUsd.toFixed(2)} risk)`,
        `Slug: \`${opts.marketSlug}\``,
        opts.fairValueUp !== null ? `Model P(Up): ${(opts.fairValueUp * 100).toFixed(1)}% · Edge: ${((opts.edge ?? 0) * 100).toFixed(1)}pp` : "",
      ].filter(Boolean).join("\n"));
    } else {
      telegram.fireAndForget(`❌ *LIVE BUY rejected*\nSide: ${opts.side} @ $${opts.price}\nError: \`${result.error ?? "unknown"}\``);
    }
  }

  /**
   * Resolve PENDING rows left behind when the process died between reserving a row and
   * recording the API result. The order may or may not have reached Polymarket:
   *  - matching resting (open) order found → it landed → adopt its id, mark PLACED.
   *  - else a matching fill in trades → it landed and filled → adopt the order id, mark PLACED.
   *  - else, only once the window has ended (so re-trading is impossible), mark FAILED.
   * While the window is still live and we can't confirm, the row stays PENDING so the slug
   * dedup keeps blocking a duplicate.
   */
  async function reconcilePendingLiveTrades(): Promise<void> {
    if (!config.live.enabled || !liveTrader.isInitialized()) return;
    const pending = store.findPendingLiveTrades();
    if (pending.length === 0) return;
    for (const p of pending) {
      try {
        // The bot only ever BUYs, and each UP/DOWN token is distinct, so the token id alone
        // identifies our order among resting orders.
        const open = await liveTrader.getOpenOrdersForToken(p.token_id);
        const match = open.find((o) => o.asset_id === p.token_id);
        if (match) {
          store.finalizeLiveOrder(p.id, { status: "PLACED", orderId: match.id, error: null });
          logger.info("Reconciled PENDING → PLACED (resting order found)", { id: p.id, orderId: match.id, slug: p.market_slug });
          continue;
        }
        if (p.condition_id) {
          const trades = (await liveTrader.getTradesForMarket(p.condition_id)) as Array<{ asset_id?: string; side?: string; taker_order_id?: string }>;
          const fill = trades.find((t) => t.asset_id === p.token_id && !!t.taker_order_id);
          if (fill?.taker_order_id) {
            store.finalizeLiveOrder(p.id, { status: "PLACED", orderId: fill.taker_order_id, error: null });
            logger.info("Reconciled PENDING → PLACED (fill found in trades)", { id: p.id, orderId: fill.taker_order_id, slug: p.market_slug });
            continue;
          }
        }
        if (p.window_end_ts * 1000 <= Date.now()) {
          store.finalizeLiveOrder(p.id, { status: "FAILED", orderId: null, error: "unconfirmed at restart; no resting order or fill after window close" });
          logger.warn("Reconciled PENDING → FAILED (window closed, no trace of order)", { id: p.id, slug: p.market_slug });
        } else {
          logger.info("PENDING order still unresolved; window active, leaving reserved", { id: p.id, slug: p.market_slug });
        }
      } catch (err) {
        logger.warn("reconcilePendingLiveTrades failed for row", { id: p.id, err: (err as Error).message });
      }
    }
  }

  let lastTickMs = Date.now();
  let stuckAlertSentAt = 0;

  async function pollTick(): Promise<void> {
    const now = Date.now();
    lastTickMs = now;
    rolloverIfNeeded(now);
    const event = state.currentEvent;
    const btc = feed.getLast();
    if (!event || !btc.price || state.windowOpenBtcPrice === null) return;

    // Staleness guard: if the feed froze (WS dropped mid-reconnect, or RTDS stopped
    // publishing), don't price/trade off a dead spot. As remainingSec->0, sigma*sqrt(T)->0
    // and a stale spot even slightly off strike drives pUp toward 0/1 — a fake high-edge
    // signal at the worst possible moment. Skip until a fresh tick arrives.
    const tickAgeMs = now - btc.ts;
    if (tickAgeMs > config.collector.maxTickAgeMs) {
      logger.debug("Skipping tick — stale BTC feed", { ageMs: tickAgeMs, maxMs: config.collector.maxTickAgeMs });
      return;
    }

    const annualVol = vol.annualizedVol();
    if (annualVol === null) return;
    const drift = vol.annualizedDrift();

    let upQ: BestQuotes = { bestBid: null, bestAsk: null, mid: null, spread: null };
    let downQ: BestQuotes = { bestBid: null, bestAsk: null, mid: null, spread: null };
    try {
      const [upBook, downBook] = await Promise.all([getOrderBook(event.yesTokenId), getOrderBook(event.noTokenId)]);
      upQ = bestQuotes(upBook);
      downQ = bestQuotes(downBook);
    } catch (err) {
      logger.debug("orderbook fetch failed", (err as Error).message);
    }

    const remainingSec = Math.max(0, (event.windowEndMs - now) / 1000);
    const fvRaw = fairValue({
      spot: btc.price, strike: state.windowOpenBtcPrice,
      // Drift estimate is too noisy at 30-min sample (SE ~±20 annualized) — past data
      // showed high estimated drift correlated with mean-reversion losses. Use 0
      // (risk-neutral martingale) instead. drift_at_entry is still recorded for analysis.
      remainingSeconds: remainingSec, annualizedVol: annualVol, drift: 0,
    });
    // Bayesian blend with market prior (Polymarket UP mid). The BS model is blind to
    // order-flow / informed-trader info that's already priced into the book; live data
    // showed it was overconfident. STRATEGY_MARKET_WEIGHT=0 disables blending.
    const fv = fvRaw ? blendWithMarket(fvRaw, upQ.mid, STRATEGY.marketWeight) : null;

    const edgeUp = fv && upQ.bestAsk !== null ? fv.pUp - upQ.bestAsk : null;
    const edgeDown = fv && downQ.bestAsk !== null ? fv.pDown - downQ.bestAsk : null;

    store.recordTick({
      ts: now, windowStartMs: event.windowStartMs, windowEndMs: event.windowEndMs, marketSlug: event.slug,
      upBestBid: upQ.bestBid, upBestAsk: upQ.bestAsk, upMid: upQ.mid,
      downBestBid: downQ.bestBid, downBestAsk: downQ.bestAsk, downMid: downQ.mid,
      btcPrice: btc.price, btcPriceAtWindowStart: state.windowOpenBtcPrice,
      realizedVol1m: annualVol, fairValueUp: fv?.pUp ?? null, edgeUp, edgeDown,
    });

    if (!fv) return;
    // Window-level dedup. When paper is enabled, paper.hasOpenPositionFor blocks duplicates.
    // When paper is disabled, fall back to DB-backed live-order check (slug already PLACED).
    if (config.paperEnabled) {
      if (paper.hasOpenPositionFor(event.slug)) return;
    } else if (config.live.enabled && store.hasPlacedLiveOrderForSlug(event.slug)) {
      return;
    }

    const decision = decide({
      fair: fv, upQuotes: upQ, downQuotes: downQ,
      minEdge: STRATEGY.minEdge, maxSpread: STRATEGY.maxSpread,
      minRemainingSec: STRATEGY.minRemainingSec, maxRemainingSec: STRATEGY.maxRemainingSec,
      remainingSec, spot: btc.price, strike: state.windowOpenBtcPrice, annualizedDrift: drift,
      maxVol: STRATEGY.maxVol, annualizedVol: annualVol,
      upOnly: STRATEGY.upOnly, minFvUp: STRATEGY.minFvUp,
      maxEdge: STRATEGY.maxEdge, minEntryPrice: STRATEGY.minEntryPrice, maxEntryPrice: STRATEGY.maxEntryPrice,
      maxBtcMovedPct: STRATEGY.maxBtcMovedPct, minBtcMovedPct: STRATEGY.minBtcMovedPct,
      requireTrendAgreement: STRATEGY.requireTrendAgreement,
    });
    if (!decision.side || decision.takerPrice === null) return;

    const riskUsd = kellyRiskUsd({
      bankrollUsd: STRATEGY.bankrollUsd, edge: decision.edge, takerPrice: decision.takerPrice,
      maxRiskFraction: RISK_LIMITS.maxRiskPerTradeUsd / STRATEGY.bankrollUsd,
      kellyFraction: STRATEGY.kellyFraction,
    });
    if (riskUsd <= 1) return;

    // Apply the same caps live uses: cap risk at LIVE_MAX_TRADE_USD, enforce Polymarket's
    // 5-share minimum, then reject if the bumped size would exceed cap * tolerance. Paper
    // and live now use identical sizing so paper P&L predicts live P&L.
    const cappedRiskUsd = Math.min(riskUsd, config.live.maxTradeUsd);
    const rawShares = cappedRiskUsd / decision.takerPrice;
    const shares = Math.max(config.collector.polymarketMinShares, Math.ceil(rawShares * 100) / 100);
    const actualRiskUsd = shares * decision.takerPrice;
    if (actualRiskUsd > config.live.maxTradeUsd * config.collector.liveSizeCapTolerance) {
      logger.debug("Skipping signal — bumping to Polymarket min would exceed cap", {
        actualRiskUsd, cap: config.live.maxTradeUsd, price: decision.takerPrice,
      });
      return;
    }

    const strategyConfigSnapshot = JSON.stringify(STRATEGY);
    // Paper trade is best-effort for analytics + risk tracking. Live runs independently
    // so a stuck paper position (in-memory bug) cannot block live order placement.
    if (config.paperEnabled) {
      paper.open({
        side: decision.side, marketSlug: event.slug, windowEndMs: event.windowEndMs,
        takerPrice: decision.takerPrice, riskUsd: actualRiskUsd, nowMs: now,
        context: {
          fairValueUp: fv.pUp,
          edge: decision.edge,
          btcPriceAtEntry: btc.price,
          btcStrike: state.windowOpenBtcPrice,
          remainingSecAtEntry: Math.round(remainingSec),
          realizedVolAtEntry: annualVol,
          driftAtEntry: drift,
          upBestBidAtEntry: upQ.bestBid,
          upBestAskAtEntry: upQ.bestAsk,
          downBestBidAtEntry: downQ.bestBid,
          downBestAskAtEntry: downQ.bestAsk,
          strategyConfig: strategyConfigSnapshot,
          btcPriceSource: config.priceSource,
          kellyRecommendedRiskUsd: riskUsd,
        },
      });
    }
    if (!config.live.enabled || !liveTrader.isInitialized()) return;

    if (liveOrdersInFlight.has(event.slug) || store.hasPlacedLiveOrderForSlug(event.slug)) {
      logger.debug("Skipping live mirror — already in-flight or PLACED for this slug", { slug: event.slug });
      return;
    }
    liveOrdersInFlight.add(event.slug);
    const inFlightSlug = event.slug;
    const inFlightTimeout = setTimeout(() => {
      liveOrdersInFlight.delete(inFlightSlug);
      logger.warn("liveOrdersInFlight cleanup timeout — placeLiveOrder hung", { slug: inFlightSlug });
    }, 30_000);
    const tokenId = decision.side === "UP" ? event.yesTokenId : event.noTokenId;
    void placeLiveOrder({
      tokenId, conditionId: event.conditionId, side: decision.side, price: decision.takerPrice, size: shares,
      windowEndMs: event.windowEndMs, marketSlug: event.slug, nowMs: now,
      fairValueUp: fv.pUp,
      edge: decision.edge,
      btcPriceAtEntry: btc.price,
      btcStrike: state.windowOpenBtcPrice,
      remainingSecAtEntry: Math.round(remainingSec),
      realizedVolAtEntry: annualVol,
      driftAtEntry: drift,
      upBestBidAtEntry: upQ.bestBid,
      upBestAskAtEntry: upQ.bestAsk,
      downBestBidAtEntry: downQ.bestBid,
      downBestAskAtEntry: downQ.bestAsk,
      strategyConfig: strategyConfigSnapshot,
      btcPriceSource: config.priceSource,
      kellyRecommendedRiskUsd: riskUsd,
    }).finally(() => {
      clearTimeout(inFlightTimeout);
      liveOrdersInFlight.delete(inFlightSlug);
    });
  }

  await refreshEvents();
  setInterval(refreshEvents, config.collector.refreshEventsMs);
  setInterval(() => { void pollTick(); }, config.collector.tickIntervalMs);

  setInterval(() => { void emitStats(); }, config.collector.statsLogMs);

  async function emitStats(): Promise<void> {
    const l = store.liveStats();
    let balanceUsd: number | null = null;
    if (config.live.enabled && liveTrader.isInitialized()) {
      try { balanceUsd = (await liveTrader.getCollateralBalance()).collateralBalanceUsd; }
      catch (err) { logger.debug("balance fetch failed", (err as Error).message); }
    }
    const balance = balanceUsd !== null ? `$${balanceUsd.toFixed(2)}` : "n/a";
    const liveSummary = { trades: l.trades, winRate: (l.winRate * 100).toFixed(1) + "%", pnl: `$${l.totalPnlUsd.toFixed(2)}`, roi: l.roiPct.toFixed(1) + "%", openOrders: l.openCount };
    const summary: Record<string, unknown> = { balance, live: liveSummary };
    if (config.paperEnabled) {
      const p = store.paperStats();
      summary.paper = { trades: p.trades, winRate: (p.winRate * 100).toFixed(1) + "%", pnl: `$${p.totalPnlUsd.toFixed(2)}`, roi: p.roiPct.toFixed(1) + "%" };
    }
    logger.info("STATS (all-time)", summary);

    if (telegram.isEnabled()) {
      const pnlEmoji = l.totalPnlUsd >= 0 ? "🟢" : "🔴";
      const lines = [
        `*📊 Bot Stats*`,
        `💰 *Balance:* ${balance} pUSD`,
        ``,
        `*Live* (real money):`,
        `${pnlEmoji} P&L: \`$${l.totalPnlUsd.toFixed(2)}\` (${l.roiPct.toFixed(1)}% ROI)`,
        `Trades: ${l.trades} · Win rate: ${(l.winRate * 100).toFixed(1)}% · Open: ${l.openCount}`,
      ];
      if (config.paperEnabled) {
        const p = store.paperStats();
        lines.push(
          ``,
          `*Paper* (sim):`,
          `Trades: ${p.trades} · Win rate: ${(p.winRate * 100).toFixed(1)}% · P&L: $${p.totalPnlUsd.toFixed(2)}`,
        );
      }
      telegram.fireAndForget(lines.join("\n"));
    }
  }

  setInterval(() => {
    void reconcilePendingLiveTrades();
    void reconcileOrphans(Date.now() - 60_000, /* quiet= */ true);
  }, config.collector.reconcileMs);

  // Level 3 health check: alert Telegram if pollTick stopped firing.
  // Re-alert only once per stuck event (reset when ticks resume).
  setInterval(() => {
    const sinceLastTick = Date.now() - lastTickMs;
    const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
    if (sinceLastTick > STUCK_THRESHOLD_MS) {
      if (stuckAlertSentAt < lastTickMs) {
        const minutes = (sinceLastTick / 60000).toFixed(1);
        logger.warn("Bot stuck — no ticks recently", { minutesIdle: minutes });
        if (telegram.isEnabled()) {
          telegram.fireAndForget(`⚠️ *Bot may be STUCK*\nNo ticks for ${minutes} min`);
        }
        stuckAlertSentAt = Date.now();
      }
    }
  }, 60_000);

  process.on("SIGINT", () => {
    logger.info("Stopping...");
    feed.stop();
    store.close();
    process.exit(0);
  });
}

async function notifyCrash(label: string, detail: string): Promise<void> {
  if (!config.telegram.botToken || !config.telegram.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${config.telegram.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegram.chatId,
        text: `🚨 *Bot ${label}*\n\`\`\`\n${detail.slice(0, 3500)}\n\`\`\``,
        parse_mode: "Markdown",
      }),
    });
  } catch {
    // best-effort; don't crash the crash handler
  }
}

process.on("uncaughtException", (err) => {
  logger.error("UNCAUGHT EXCEPTION:", err);
  void notifyCrash("CRASHED (uncaughtException)", `${err.message}\n${err.stack ?? ""}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error("UNHANDLED REJECTION:", reason);
  const detail = reason instanceof Error ? `${reason.message}\n${reason.stack ?? ""}` : String(reason);
  void notifyCrash("Unhandled async error", detail);
});

main().catch((err) => {
  logger.error(err);
  void notifyCrash("STARTUP FAILED", `${err.message}\n${err.stack ?? ""}`).finally(() => process.exit(1));
});
