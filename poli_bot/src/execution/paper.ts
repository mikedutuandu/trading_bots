import { logger } from "../logger.js";
import { sideWins, type Side } from "../types.js";
import type { RiskManager } from "./risk.js";

const TAKER_FEE_FRACTION = 0.02;

export interface PaperPositionContext {
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
}

export interface PaperPosition {
  id: string;
  side: Side;
  marketSlug: string;
  windowEndMs: number;
  enteredAt: number;
  takerPrice: number;
  shares: number;
  feesUsd: number;
  riskUsd: number;
  context: PaperPositionContext;
}

export interface PaperTradeResult {
  position: PaperPosition;
  closePrice: number;
  realizedPnlUsd: number;
  win: boolean;
}

export class PaperTrader {
  private positions = new Map<string, PaperPosition>();
  private nextId = 1;

  constructor(private risk: RiskManager) {}

  open(opts: {
    side: Side;
    marketSlug: string;
    windowEndMs: number;
    takerPrice: number;
    riskUsd: number;
    nowMs: number;
    context: PaperPositionContext;
  }): PaperPosition | null {
    const check = this.risk.canOpen(opts.riskUsd);
    if (!check.ok) {
      logger.debug("paper open rejected:", check.reason);
      return null;
    }
    if (opts.takerPrice <= 0 || opts.takerPrice >= 1) return null;
    const shares = opts.riskUsd / opts.takerPrice;
    const feesUsd = shares * opts.takerPrice * TAKER_FEE_FRACTION;
    const pos: PaperPosition = {
      id: String(this.nextId++),
      side: opts.side,
      marketSlug: opts.marketSlug,
      windowEndMs: opts.windowEndMs,
      enteredAt: opts.nowMs,
      takerPrice: opts.takerPrice,
      shares,
      feesUsd,
      riskUsd: opts.riskUsd,
      context: opts.context,
    };
    this.positions.set(pos.id, pos);
    this.risk.onOpen();
    const maxProfitUsd = shares * (1 - opts.takerPrice) - feesUsd;
    logger.info("paper OPEN", {
      id: pos.id,
      side: pos.side,
      slug: pos.marketSlug,
      price: pos.takerPrice,
      shares: shares.toFixed(2),
      risk: `$${pos.riskUsd.toFixed(2)}`,
      maxProfit: `+$${maxProfitUsd.toFixed(2)}`,
      maxLoss: `-$${opts.riskUsd.toFixed(2)}`,
    });
    return pos;
  }

  resolveWindow(windowEndMs: number, marketSlug: string, upWon: boolean): PaperTradeResult[] {
    const results: PaperTradeResult[] = [];
    for (const pos of [...this.positions.values()]) {
      if (pos.windowEndMs !== windowEndMs || pos.marketSlug !== marketSlug) continue;
      const win = sideWins(pos.side, upWon);
      const closePrice = win ? 1 : 0;
      const realizedPnlUsd = (closePrice - pos.takerPrice) * pos.shares - pos.feesUsd;
      this.positions.delete(pos.id);
      this.risk.onClose(realizedPnlUsd);
      results.push({ position: pos, closePrice, realizedPnlUsd, win });
      logger.info("paper CLOSE", { id: pos.id, side: pos.side, win, pnl: realizedPnlUsd.toFixed(2) });
    }
    return results;
  }

  hasOpenPositionFor(marketSlug: string): boolean {
    for (const pos of this.positions.values()) if (pos.marketSlug === marketSlug) return true;
    return false;
  }
}
