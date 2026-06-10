import { config } from "../config.js";
import { logger } from "../logger.js";
import { intervalMs } from "../util.js";
import { getCandles } from "../storage/candles.js";
import { getFundingRates } from "../storage/funding.js";
import { getExchangeInfo } from "../exchange/marketData.js";
import type { Candle, CloseReason, Trade } from "../types.js";
import { computeIndicators } from "../playbooks/index.js";
import { ema } from "../indicators/ta.js";
import type { IndicatorCtx, Playbook, StrategyParams } from "../playbooks/types.js";
import { sizePosition, splitTranches, type SizingOpts } from "../risk/sizing.js";
import { closeReasonOf, manageOnCandle, type RuntimePosition } from "../risk/manage.js";
import { EMA_WARMUP_BARS, againstPosition, fasterTfUp } from "../risk/guardian.js";

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
  /** Live M8 sizing caps (riskUsdt / maxTradeRisk / maxNotional) — pass for live parity. */
  sizing?: SizingOpts;
  from?: number;
  to?: number;
  /** Simulate the LIVE execution overlay on top of the candle-close engine:
   *  - the guardian's faster-TF trend-flip exit (REVERSAL_CLOSE) on closed reversalTf
   *    candles, pre-TP2 only — exactly the live monitorOpenPositions Layer B;
   *  - intra-bar stop enforcement at reversalTf granularity (live = resting stop +
   *    per-minute guardian), so stop-vs-flip ORDERING inside the hour is faithful;
   *  - TP1/TP2 fills priced at the bar CLOSE (live takes profit with a market order
   *    on the hourly tick), not at the TP level the candle merely touched.
   *  Requires reversalTf candles in the research DB (TIMEFRAME=15m npm run collect). */
  liveSim?: {
    reversalTf: string;
    /** Mirror of MONITOR_REVERSAL_MODE === "exit": false = no flip exits (warn/off). */
    reversalExit: boolean;
  };
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
  gd?: GuardianData; // liveSim only: faster-TF series + EMAs for the guardian overlay
}

/** Faster-TF (reversalTf) series for the guardian simulation — parallel arrays. */
interface GuardianData {
  tfMs: number;
  times: number[]; // openTime, ascending
  close: number[];
  high: number[];
  low: number[];
  ema50: number[];
  ema200: number[];
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

  let liveSimMissing = 0;
  for (const symbol of cfg.symbols) {
    const candles = getCandles(symbol, config.strategy.timeframe, { from: cfg.from, to: cfg.to });
    if (candles.length < EMA_WARMUP_BARS) continue; // need warmup for EMA200
    const ind = computeIndicators(candles, cfg.params.donchianPeriod);
    const indexByTime = new Map<number, number>();
    candles.forEach((c, i) => {
      indexByTime.set(c.openTime, i);
      allTimes.add(c.openTime);
    });
    const funding = getFundingRates(symbol);

    let gd: GuardianData | undefined;
    if (cfg.liveSim) {
      const tfMs = intervalMs(cfg.liveSim.reversalTf);
      // Load extra history BEFORE the window so the faster-TF EMAs are warmed up at from.
      const g = getCandles(symbol, cfg.liveSim.reversalTf, {
        from: cfg.from !== undefined ? cfg.from - (EMA_WARMUP_BARS + 50) * tfMs : undefined,
        to: cfg.to,
      });
      if (g.length >= EMA_WARMUP_BARS) {
        const closes = g.map((c) => c.close);
        gd = {
          tfMs,
          times: g.map((c) => c.openTime),
          close: closes,
          high: g.map((c) => c.high),
          low: g.map((c) => c.low),
          ema50: ema(closes, 50),
          ema200: ema(closes, 200),
        };
      } else {
        liveSimMissing++;
      }
    }

    data.set(symbol, {
      candles,
      ind,
      indexByTime,
      fundingTimes: funding.times,
      fundingRates: funding.rates,
      gd,
    });
  }
  if (cfg.liveSim && liveSimMissing > 0) {
    logger.warn(
      `liveSim: ${liveSimMissing} symbol(s) lack ${cfg.liveSim.reversalTf} candles — guardian NOT simulated there ` +
        `(run \`TIMEFRAME=${cfg.liveSim.reversalTf} npm run collect\`)`,
    );
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

  /** Realize one exit fill into the trade + account (slippage against us, taker fee). */
  const settleExit = (ot: OpenTrade, qty: number, rawPrice: number): void => {
    const long = ot.pos.side === "long";
    const exitEff = long ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
    const gross = long ? (exitEff - ot.pos.entry) * qty : (ot.pos.entry - exitEff) * qty;
    const fee = rawPrice * qty * cfg.takerFee;
    ot.grossPnl += gross;
    ot.commission += fee;
    equity += gross - fee; // realize incrementally → compounding
  };

  /** Journal a fully-closed trade and free the symbol's slot. */
  const journalClose = (ot: OpenTrade, exitPrice: number, reason: CloseReason, ts: number, barIdx: number): void => {
    const netPnl = ot.grossPnl - ot.commission + ot.funding;
    closed.push({
      id: ot.id,
      symbol: ot.symbol,
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
      exitPrice,
      closeReason: reason,
      rRealized: ot.riskUsdt > 0 ? netPnl / ot.riskUsdt : 0,
      grossPnl: ot.grossPnl,
      commission: ot.commission,
      funding: ot.funding,
      netPnl,
      openedAt: ot.openedAt,
      closedAt: ts,
    });
    open.delete(ot.symbol);
    lastCloseBar.set(ot.symbol, barIdx);
  };

  /** liveSim Layer B: is the faster-TF trend AGAINST the position at sub-candle k?
   *  (Live guardian: up = ema50>ema200; long is against on !up, short on up; pre-TP2 only.) */
  const flipAgainst = (gd: GuardianData, k: number, long: boolean): boolean => {
    if (k < EMA_WARMUP_BARS) return false;
    const e50 = gd.ema50[k]!;
    const e200 = gd.ema200[k]!;
    if (!Number.isFinite(e50) || !Number.isFinite(e200)) return false;
    return againstPosition(fasterTfUp(e50, e200), long);
  };

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

      // ── liveSim Layers A+B: walk the faster-TF sub-candles INSIDE this bar in time
      // order, so a mid-hour stop hit and a mid-hour trend flip sequence faithfully
      // (live: resting stop + per-minute guardian act long before the hourly tick).
      const gd = sd.gd;
      const barEnd = c.closeTime + 1;
      let boundaryIdx = -1; // sub-candle closing exactly ON the bar boundary
      if (gd) {
        const long = ot.pos.side === "long";
        let exited = false;
        for (let k = firstAfter(gd.times, ts - 1); k < gd.times.length && gd.times[k]! < barEnd; k++) {
          if (gd.times[k]! + gd.tfMs >= barEnd) {
            boundaryIdx = k; // its verdict lands AT the hourly tick → checked after manage
            break;
          }
          // Layer A — stop enforced intra-bar (exit at the stop, like the resting stop).
          if (long ? gd.low[k]! <= ot.pos.stop : gd.high[k]! >= ot.pos.stop) {
            settleExit(ot, ot.pos.qtyRemaining, ot.pos.stop);
            journalClose(ot, ot.pos.stop, ot.pos.tp1Hit ? "MANAGED_STOP" : "STOP", ts, i);
            exited = true;
            break;
          }
          // Layer B — faster-TF trend flip at this sub-close (pre-TP2 only, like live).
          if (cfg.liveSim!.reversalExit && !ot.pos.tp2Hit && flipAgainst(gd, k, long)) {
            settleExit(ot, ot.pos.qtyRemaining, gd.close[k]!);
            journalClose(ot, gd.close[k]!, "REVERSAL_CLOSE", ts, i);
            exited = true;
            break;
          }
        }
        if (exited) continue;
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

      let lastExitPrice = 0;
      for (const f of fills) {
        // liveSim: TP tranches execute as market orders ON the hourly tick → the realized
        // price is the bar CLOSE, not the TP level the candle merely touched. Stops and
        // HEALTH_CLOSE already fill at their true live price (stop level / bar close).
        const price = cfg.liveSim && (f.kind === "TP1" || f.kind === "TP2") ? c.close : f.price;
        settleExit(ot, f.qty, price);
        lastExitPrice = price;
      }

      if (isClosed) {
        journalClose(ot, lastExitPrice, closeReasonOf(fills[fills.length - 1]!.kind), ts, i);
        continue;
      }

      // liveSim: the boundary sub-candle's verdict is seen by the guardian right AFTER
      // the hourly tick managed this bar (live: tick first, guardian within the minute).
      if (gd && boundaryIdx >= 0 && cfg.liveSim!.reversalExit && !ot.pos.tp2Hit) {
        const long = ot.pos.side === "long";
        if (flipAgainst(gd, boundaryIdx, long)) {
          settleExit(ot, ot.pos.qtyRemaining, gd.close[boundaryIdx]!);
          journalClose(ot, gd.close[boundaryIdx]!, "REVERSAL_CLOSE", ts, i);
        }
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
        const sized = sizePosition(signal, equity, cfg.riskPct, cfg.leverage, filter, cfg.sizing);
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
