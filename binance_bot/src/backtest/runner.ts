import { config } from "../config.js";
import { logger } from "../logger.js";
import { getCandles } from "../storage/candles.js";
import { getFundingRates } from "../storage/funding.js";
import { getExchangeInfo } from "../exchange/marketData.js";
import type { Candle, Trade } from "../types.js";
import { computeIndicators } from "../playbooks/index.js";
import type { IndicatorCtx, Playbook, StrategyParams } from "../playbooks/types.js";
import { sizePosition, splitTranches } from "../risk/sizing.js";
import { closeReasonOf, manageOnCandle, type RuntimePosition } from "../risk/manage.js";

export interface BacktestConfig {
  symbols: string[];
  playbooks: Playbook[];
  params: StrategyParams;
  startEquity: number;
  riskPct: number;
  leverage: number;
  takerFee: number;
  slippageBps: number;
  maxOpenPositions: number;
  maxDailyLossPct: number;
  from?: number;
  to?: number;
}

export interface BacktestResult {
  trades: Trade[];
  equityCurve: Array<{ ts: number; equity: number }>;
  startEquity: number;
  endEquity: number;
}

interface SymbolData {
  candles: Candle[];
  ind: IndicatorCtx;
  indexByTime: Map<number, number>;
  // Funding settlements (8h) for this symbol, ascending by time. Parallel arrays
  // for cheap forward-scan inside the position-management loop.
  fundingTimes: number[];
  fundingRates: number[];
}

interface OpenTrade {
  id: string;
  symbol: string;
  pos: RuntimePosition;
  playbook: string;
  setup: string;
  notional: number;
  riskUsdt: number;
  grossPnl: number;
  commission: number;
  funding: number; // accumulated funding cashflow (positive = received, negative = paid)
  fundingCursor: number; // index into the symbol's fundingTimes already charged
  openedAt: number;
  rPlanned: number;
}

const slipFactor = (bps: number) => bps / 10_000;

/** First index i where times[i] > t (the first settlement strictly after entry). */
function firstAfter(times: number[], t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (times[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  const filters = await getExchangeInfo();
  const data = new Map<string, SymbolData>();
  const allTimes = new Set<number>();

  for (const symbol of cfg.symbols) {
    const candles = getCandles(symbol, config.strategy.timeframe, { from: cfg.from, to: cfg.to });
    if (candles.length < 250) continue; // need warmup for EMA200
    const ind = computeIndicators(candles, cfg.params.donchianPeriod);
    const indexByTime = new Map<number, number>();
    candles.forEach((c, i) => {
      indexByTime.set(c.openTime, i);
      allTimes.add(c.openTime);
    });
    const funding = getFundingRates(symbol);
    data.set(symbol, {
      candles,
      ind,
      indexByTime,
      fundingTimes: funding.times,
      fundingRates: funding.rates,
    });
  }

  const timeline = [...allTimes].sort((a, b) => a - b);
  logger.info(
    `backtest: ${data.size} symbols, ${timeline.length} bars, ` +
      `${cfg.playbooks.map((p) => p.name).join("+")}`,
  );

  let equity = cfg.startEquity;
  const open = new Map<string, OpenTrade>();
  const closed: Trade[] = [];
  const equityCurve: Array<{ ts: number; equity: number }> = [];

  let currentDay = "";
  let dayStartEquity = equity;
  let blockedToday = false;
  let idSeq = 0;
  const lastCloseBar = new Map<string, number>(); // per-symbol bar index of last close (cooldown)

  const slip = slipFactor(cfg.slippageBps);

  for (const ts of timeline) {
    const day = new Date(ts).toISOString().slice(0, 10);
    if (day !== currentDay) {
      currentDay = day;
      dayStartEquity = equity;
      blockedToday = false;
    }

    // ── Pass 1: manage existing positions (frees capacity for entries) ──
    for (const [symbol, ot] of [...open]) {
      const sd = data.get(symbol)!;
      const i = sd.indexByTime.get(ts);
      if (i === undefined) continue; // this symbol has no candle at ts
      const c = sd.candles[i]!;
      const ema50 = sd.ind.ema50[i]!;
      const ema200 = sd.ind.ema200[i]!;
      const atrNow = sd.ind.atr14[i] ?? NaN;

      // ── Funding: charge any 8h settlement that lands inside this candle ──
      // sign=+1 long / -1 short; a long PAYS when rate>0 (cashflow negative).
      // Notional uses the remaining qty at the candle close as the mark proxy.
      {
        const sign = ot.pos.side === "long" ? 1 : -1;
        const times = sd.fundingTimes;
        // Skip any settlement before this candle (e.g. a candle-data gap) without charging.
        while (ot.fundingCursor < times.length && times[ot.fundingCursor]! < c.openTime) {
          ot.fundingCursor++;
        }
        // Charge every 8h settlement that lands inside [openTime, closeTime].
        while (
          ot.fundingCursor < times.length &&
          times[ot.fundingCursor]! <= c.closeTime
        ) {
          const rate = sd.fundingRates[ot.fundingCursor]!;
          const notionalNow = ot.pos.qtyRemaining * c.close;
          const cashflow = -sign * rate * notionalNow;
          ot.funding += cashflow;
          equity += cashflow;
          ot.fundingCursor++;
        }
      }

      const { fills, closed: isClosed } = manageOnCandle(ot.pos, c, {
        bar: i,
        trendUp: ema50 > ema200,
        atr: atrNow,
        trailMult: cfg.params.trailMult,
        maxHoldBars: cfg.params.maxHoldBars,
        stallBars: cfg.params.stallBars,
        maxTotalBars: cfg.params.maxTotalBars,
      });

      for (const f of fills) {
        const long = ot.pos.side === "long";
        const exitEff = long ? f.price * (1 - slip) : f.price * (1 + slip);
        const gross = long
          ? (exitEff - ot.pos.entry) * f.qty
          : (ot.pos.entry - exitEff) * f.qty;
        const fee = f.price * f.qty * cfg.takerFee;
        ot.grossPnl += gross;
        ot.commission += fee;
        equity += gross - fee; // realize incrementally → compounding
      }

      if (isClosed) {
        const lastKind = fills[fills.length - 1]!.kind;
        const netPnl = ot.grossPnl - ot.commission + ot.funding;
        closed.push({
          id: ot.id,
          symbol,
          side: ot.pos.side,
          playbook: ot.playbook as Trade["playbook"],
          setup: ot.setup,
          timeframe: config.strategy.timeframe,
          entryPrice: ot.pos.entry,
          stopPrice: ot.pos.tp1, // initial stop replaced at runtime; keep tp for ref
          qty: ot.pos.qtyTotal,
          notional: ot.notional,
          leverage: cfg.leverage,
          riskUsdt: ot.riskUsdt,
          rPlanned: ot.rPlanned,
          tp1: ot.pos.tp1,
          tp2: ot.pos.tp2,
          tp3: ot.pos.tp3,
          status: "CLOSED",
          exitPrice: fills[fills.length - 1]!.price,
          closeReason: closeReasonOf(lastKind),
          rRealized: ot.riskUsdt > 0 ? netPnl / ot.riskUsdt : 0,
          grossPnl: ot.grossPnl,
          commission: ot.commission,
          funding: ot.funding,
          netPnl,
          openedAt: ot.openedAt,
          closedAt: ts,
        });
        open.delete(symbol);
        lastCloseBar.set(symbol, i);
      }
    }

    // Kill switch: block new entries if today's drawdown exceeds the cap.
    if (!blockedToday && equity <= dayStartEquity * (1 - cfg.maxDailyLossPct)) {
      blockedToday = true;
    }

    // ── Pass 2: entries ──
    if (blockedToday || open.size >= cfg.maxOpenPositions) {
      equityCurve.push({ ts, equity });
      continue;
    }
    for (const [symbol, sd] of data) {
      if (open.size >= cfg.maxOpenPositions) break;
      if (open.has(symbol)) continue;
      const i = sd.indexByTime.get(ts);
      if (i === undefined) continue;
      const filter = filters.get(symbol);
      if (!filter) continue;

      // Per-symbol entry cooldown after a close (cuts over-trading / fees).
      if (cfg.params.cooldownBars > 0) {
        const lastClose = lastCloseBar.get(symbol);
        if (lastClose !== undefined && i - lastClose < cfg.params.cooldownBars) continue;
      }

      for (const pb of cfg.playbooks) {
        const signal = pb.detect(sd.candles, i, sd.ind, cfg.params);
        if (!signal) continue;
        const sized = sizePosition(signal, equity, cfg.riskPct, cfg.leverage, filter);
        if (!sized) continue;

        const long = signal.side === "long";
        const entryEff = long ? sized.entry * (1 + slip) : sized.entry * (1 - slip);
        const entryFee = sized.entry * sized.qty * cfg.takerFee;
        equity -= entryFee;

        // Step-rounded TP tranches (shared with the live engine for parity).
        const { qtyTp1, qtyTp2 } = splitTranches(
          sized.qty,
          cfg.params.takeFrac1,
          cfg.params.takeFrac2,
          filter.stepSize,
        );
        const pos: RuntimePosition = {
          side: signal.side,
          entry: entryEff,
          stop: sized.stop,
          tp1: sized.tp1,
          tp2: sized.tp2,
          tp3: sized.tp3,
          qtyTotal: sized.qty,
          qtyRemaining: sized.qty,
          qtyTp1,
          qtyTp2,
          tp1Hit: false,
          tp2Hit: false,
          trailActive: false,
          trailExtreme: entryEff,
          openedAtBar: i,
        };
        open.set(symbol, {
          id: `${symbol}-${ts}-${idSeq++}`,
          symbol,
          pos,
          playbook: signal.playbook,
          setup: signal.setup,
          notional: sized.notional,
          riskUsdt: sized.riskUsdt,
          grossPnl: 0,
          commission: entryFee,
          funding: 0,
          fundingCursor: firstAfter(sd.fundingTimes, ts),
          openedAt: ts,
          rPlanned: cfg.params.rMultiples[2],
        });
        break; // one playbook entry per symbol per bar
      }
    }

    equityCurve.push({ ts, equity });
  }

  return { trades: closed, equityCurve, startEquity: cfg.startEquity, endEquity: equity };
}
