import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CollectorTick, Side } from "../types.js";

export interface PaperTradeRow {
  windowEndTs: number;
  marketSlug: string;
  side: Side;
  enteredAtMs: number;
  takerPrice: number;
  shares: number;
  riskUsd: number;
  feesUsd: number;
  fairValueUp: number | null;
  edge: number | null;
  closePrice: number | null;
  realizedPnlUsd: number | null;
  win: 0 | 1 | null;
  btcPriceAtEntry: number | null;
  btcStrike: number | null;
  remainingSecAtEntry: number | null;
  realizedVolAtEntry: number | null;
  driftAtEntry: number | null;
  upBestBidAtEntry: number | null;
  upBestAskAtEntry: number | null;
  downBestBidAtEntry: number | null;
  downBestAskAtEntry: number | null;
  btcPriceAtClose: number | null;
  strategyConfig: string | null;
  btcPriceSource: string | null;
  kellyRecommendedRiskUsd: number | null;
}

export interface LiveTradeRow {
  id: number;
  order_id: string | null;
  market_slug: string;
  side: Side;
  limit_price: number;
  requested_shares: number;
  window_end_ts: number;
}

export interface PendingLiveTradeRow extends LiveTradeRow {
  token_id: string;
  condition_id: string | null;
}

interface PaperStats {
  trades: number; wins: number; winRate: number;
  totalPnlUsd: number; totalRiskUsd: number; roiPct: number;
}

interface LiveStats extends PaperStats { openCount: number }

export class TickStore {
  private db: Database.Database;
  private insertTickStmt: Database.Statement;
  private insertPaperStmt: Database.Statement;
  private insertLiveStmt: Database.Statement;
  private finalizeLiveStmt: Database.Statement;
  private findPendingStmt: Database.Statement;
  private updateLiveSettledStmt: Database.Statement;
  private recordOutcomeStmt: Database.Statement;
  private recordPolyOutcomeStmt: Database.Statement;
  private findUnsettledStmt: Database.Statement;
  private findPlacedForWindowStmt: Database.Statement;
  private hasPlacedForSlugStmt: Database.Statement;
  private windowOpenPriceStmt: Database.Statement;
  private paperStatsStmt: Database.Statement;
  private liveStatsStmt: Database.Statement;
  private openLiveCountStmt: Database.Statement;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ticks (
        ts INTEGER NOT NULL,
        window_start_ms INTEGER NOT NULL,
        window_end_ms INTEGER NOT NULL,
        market_slug TEXT NOT NULL,
        up_best_bid REAL,
        up_best_ask REAL,
        up_mid REAL,
        down_best_bid REAL,
        down_best_ask REAL,
        down_mid REAL,
        btc_price REAL NOT NULL,
        btc_price_at_window_start REAL,
        realized_vol_1m REAL,
        fair_value_up REAL,
        edge_up REAL,
        edge_down REAL
      );
      CREATE INDEX IF NOT EXISTS ticks_window_end ON ticks(window_end_ms, ts);

      CREATE TABLE IF NOT EXISTS window_outcomes (
        window_end_ts INTEGER PRIMARY KEY,
        market_slug TEXT NOT NULL,
        btc_price_open REAL,
        btc_price_close REAL,
        outcome_up INTEGER,
        polymarket_outcome_up INTEGER
      );

      CREATE TABLE IF NOT EXISTS paper_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        window_end_ts INTEGER NOT NULL,
        market_slug TEXT NOT NULL,
        side TEXT NOT NULL,
        entered_at_ms INTEGER NOT NULL,
        taker_price REAL NOT NULL,
        shares REAL NOT NULL,
        risk_usd REAL NOT NULL,
        fees_usd REAL NOT NULL,
        fair_value_up REAL,
        edge REAL,
        close_price REAL,
        realized_pnl_usd REAL,
        win INTEGER,
        btc_price_at_entry REAL,
        btc_strike REAL,
        remaining_sec_at_entry INTEGER,
        realized_vol_at_entry REAL,
        drift_at_entry REAL,
        up_best_bid_at_entry REAL,
        up_best_ask_at_entry REAL,
        down_best_bid_at_entry REAL,
        down_best_ask_at_entry REAL,
        btc_price_at_close REAL,
        strategy_config TEXT,
        btc_price_source TEXT,
        kelly_recommended_risk_usd REAL,
        entered_at_iso TEXT GENERATED ALWAYS AS (datetime(entered_at_ms/1000, 'unixepoch')) VIRTUAL
      );
      CREATE INDEX IF NOT EXISTS paper_window ON paper_trades(window_end_ts);
      CREATE INDEX IF NOT EXISTS paper_win ON paper_trades(win);

      CREATE TABLE IF NOT EXISTS live_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id TEXT,
        window_end_ts INTEGER NOT NULL,
        market_slug TEXT NOT NULL,
        token_id TEXT NOT NULL,
        condition_id TEXT,
        side TEXT NOT NULL,
        limit_price REAL NOT NULL,
        requested_shares REAL NOT NULL,
        risk_usd REAL NOT NULL,
        placed_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        filled_shares REAL,
        avg_fill_price REAL,
        fees_usd REAL,
        polymarket_outcome_up INTEGER,
        realized_pnl_usd REAL,
        closed_at_ms INTEGER,
        error TEXT,
        fair_value_up REAL,
        edge REAL,
        btc_price_at_entry REAL,
        btc_strike REAL,
        remaining_sec_at_entry INTEGER,
        realized_vol_at_entry REAL,
        drift_at_entry REAL,
        up_best_bid_at_entry REAL,
        up_best_ask_at_entry REAL,
        down_best_bid_at_entry REAL,
        down_best_ask_at_entry REAL,
        btc_price_at_close REAL,
        strategy_config TEXT,
        btc_price_source TEXT,
        kelly_recommended_risk_usd REAL,
        placed_at_iso TEXT GENERATED ALWAYS AS (datetime(placed_at_ms/1000, 'unixepoch')) VIRTUAL,
        closed_at_iso TEXT GENERATED ALWAYS AS (datetime(closed_at_ms/1000, 'unixepoch')) VIRTUAL
      );
      CREATE INDEX IF NOT EXISTS live_window_status ON live_trades(window_end_ts, status);
      CREATE INDEX IF NOT EXISTS live_slug_status ON live_trades(market_slug, status);
      CREATE INDEX IF NOT EXISTS live_outcome ON live_trades(polymarket_outcome_up);
      CREATE INDEX IF NOT EXISTS live_order_id ON live_trades(order_id);
    `);
    const woCols = this.db.prepare(`PRAGMA table_info(window_outcomes)`).all() as { name: string }[];
    if (!woCols.some((c) => c.name === "polymarket_outcome_up")) {
      this.db.exec(`ALTER TABLE window_outcomes ADD COLUMN polymarket_outcome_up INTEGER`);
    }
    const contextCols = [
      ["btc_price_at_entry", "REAL"], ["btc_strike", "REAL"],
      ["remaining_sec_at_entry", "INTEGER"],
      ["realized_vol_at_entry", "REAL"], ["drift_at_entry", "REAL"],
      ["up_best_bid_at_entry", "REAL"], ["up_best_ask_at_entry", "REAL"],
      ["down_best_bid_at_entry", "REAL"], ["down_best_ask_at_entry", "REAL"],
      ["btc_price_at_close", "REAL"],
      ["strategy_config", "TEXT"],
      ["btc_price_source", "TEXT"],
      ["kelly_recommended_risk_usd", "REAL"],
    ] as const;
    const liveCols = this.db.prepare(`PRAGMA table_info(live_trades)`).all() as { name: string }[];
    const liveNames = new Set(liveCols.map((c) => c.name));
    for (const [col, type] of [["fair_value_up", "REAL"], ["edge", "REAL"], ["condition_id", "TEXT"], ...contextCols] as const) {
      if (!liveNames.has(col)) this.db.exec(`ALTER TABLE live_trades ADD COLUMN ${col} ${type}`);
    }
    const paperCols = this.db.prepare(`PRAGMA table_info(paper_trades)`).all() as { name: string }[];
    const paperNames = new Set(paperCols.map((c) => c.name));
    for (const [col, type] of contextCols) {
      if (!paperNames.has(col)) this.db.exec(`ALTER TABLE paper_trades ADD COLUMN ${col} ${type}`);
    }
    // Generated VIRTUAL columns aren't always visible via PRAGMA table_info — use table_xinfo
    // which lists hidden columns too. Wrap in try/catch as a final safety net.
    const paperColsAll = this.db.prepare(`PRAGMA table_xinfo(paper_trades)`).all() as { name: string }[];
    const liveColsAll = this.db.prepare(`PRAGMA table_xinfo(live_trades)`).all() as { name: string }[];
    const paperAllNames = new Set(paperColsAll.map((c) => c.name));
    const liveAllNames = new Set(liveColsAll.map((c) => c.name));
    const tryAddGenerated = (sql: string): void => {
      try { this.db.exec(sql); } catch (err) {
        if (!(err as Error).message?.includes("duplicate column")) throw err;
      }
    };
    if (!paperAllNames.has("entered_at_iso")) {
      tryAddGenerated(`ALTER TABLE paper_trades ADD COLUMN entered_at_iso TEXT GENERATED ALWAYS AS (datetime(entered_at_ms/1000, 'unixepoch')) VIRTUAL`);
    }
    if (!liveAllNames.has("placed_at_iso")) {
      tryAddGenerated(`ALTER TABLE live_trades ADD COLUMN placed_at_iso TEXT GENERATED ALWAYS AS (datetime(placed_at_ms/1000, 'unixepoch')) VIRTUAL`);
    }
    if (!liveAllNames.has("closed_at_iso")) {
      tryAddGenerated(`ALTER TABLE live_trades ADD COLUMN closed_at_iso TEXT GENERATED ALWAYS AS (datetime(closed_at_ms/1000, 'unixepoch')) VIRTUAL`);
    }

    this.insertTickStmt = this.db.prepare(`
      INSERT INTO ticks (
        ts, window_start_ms, window_end_ms, market_slug,
        up_best_bid, up_best_ask, up_mid,
        down_best_bid, down_best_ask, down_mid,
        btc_price, btc_price_at_window_start, realized_vol_1m,
        fair_value_up, edge_up, edge_down
      ) VALUES (
        @ts, @windowStartMs, @windowEndMs, @marketSlug,
        @upBestBid, @upBestAsk, @upMid,
        @downBestBid, @downBestAsk, @downMid,
        @btcPrice, @btcPriceAtWindowStart, @realizedVol1m,
        @fairValueUp, @edgeUp, @edgeDown
      )
    `);
    this.insertPaperStmt = this.db.prepare(`
      INSERT INTO paper_trades (
        window_end_ts, market_slug, side, entered_at_ms, taker_price, shares, risk_usd, fees_usd,
        fair_value_up, edge, close_price, realized_pnl_usd, win,
        btc_price_at_entry, btc_strike, remaining_sec_at_entry,
        realized_vol_at_entry, drift_at_entry,
        up_best_bid_at_entry, up_best_ask_at_entry,
        down_best_bid_at_entry, down_best_ask_at_entry, btc_price_at_close,
        strategy_config, btc_price_source, kelly_recommended_risk_usd
      ) VALUES (
        @windowEndTs, @marketSlug, @side, @enteredAtMs, @takerPrice, @shares, @riskUsd, @feesUsd,
        @fairValueUp, @edge, @closePrice, @realizedPnlUsd, @win,
        @btcPriceAtEntry, @btcStrike, @remainingSecAtEntry,
        @realizedVolAtEntry, @driftAtEntry,
        @upBestBidAtEntry, @upBestAskAtEntry,
        @downBestBidAtEntry, @downBestAskAtEntry, @btcPriceAtClose,
        @strategyConfig, @btcPriceSource, @kellyRecommendedRiskUsd
      )
    `);
    this.insertLiveStmt = this.db.prepare(`
      INSERT INTO live_trades (
        order_id, window_end_ts, market_slug, token_id, condition_id, side, limit_price,
        requested_shares, risk_usd, placed_at_ms, status, error,
        fair_value_up, edge, btc_price_at_entry, btc_strike,
        remaining_sec_at_entry, realized_vol_at_entry, drift_at_entry,
        up_best_bid_at_entry, up_best_ask_at_entry,
        down_best_bid_at_entry, down_best_ask_at_entry,
        strategy_config, btc_price_source, kelly_recommended_risk_usd
      ) VALUES (
        @orderId, @windowEndTs, @marketSlug, @tokenId, @conditionId, @side, @limitPrice,
        @requestedShares, @riskUsd, @placedAtMs, @status, @error,
        @fairValueUp, @edge, @btcPriceAtEntry, @btcStrike,
        @remainingSecAtEntry, @realizedVolAtEntry, @driftAtEntry,
        @upBestBidAtEntry, @upBestAskAtEntry,
        @downBestBidAtEntry, @downBestAskAtEntry,
        @strategyConfig, @btcPriceSource, @kellyRecommendedRiskUsd
      )
    `);
    this.finalizeLiveStmt = this.db.prepare(`
      UPDATE live_trades SET status = @status, order_id = @orderId, error = @error WHERE id = @id
    `);
    this.updateLiveSettledStmt = this.db.prepare(`
      UPDATE live_trades SET
        status = @status,
        filled_shares = @filledShares,
        avg_fill_price = @avgFillPrice,
        fees_usd = @feesUsd,
        polymarket_outcome_up = @polymarketOutcomeUp,
        realized_pnl_usd = @realizedPnlUsd,
        closed_at_ms = @closedAtMs,
        btc_price_at_close = @btcPriceAtClose
      WHERE id = @id
    `);
    this.recordOutcomeStmt = this.db.prepare(`
      INSERT INTO window_outcomes (window_end_ts, market_slug, btc_price_open, btc_price_close, outcome_up)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(window_end_ts) DO UPDATE SET
        btc_price_open = excluded.btc_price_open,
        btc_price_close = excluded.btc_price_close,
        outcome_up = excluded.outcome_up
    `);
    this.recordPolyOutcomeStmt = this.db.prepare(`
      UPDATE window_outcomes SET polymarket_outcome_up = ? WHERE window_end_ts = ?
    `);
    this.findUnsettledStmt = this.db.prepare(`
      SELECT id, order_id, market_slug, side, limit_price, requested_shares, window_end_ts
      FROM live_trades
      WHERE status = 'PLACED' AND window_end_ts * 1000 <= ?
      ORDER BY window_end_ts
    `);
    this.findPlacedForWindowStmt = this.db.prepare(`
      SELECT id, order_id, market_slug, side, limit_price, requested_shares, window_end_ts
      FROM live_trades
      WHERE window_end_ts = ? AND status = 'PLACED'
    `);
    // PENDING and PLACED both count as "already attempted for this slug" so a restart
    // can never send a second real-money order for a window we've already touched.
    this.hasPlacedForSlugStmt = this.db.prepare(`
      SELECT 1 FROM live_trades WHERE market_slug = ? AND status IN ('PENDING','PLACED') LIMIT 1
    `);
    // Reserved-but-unconfirmed orders (process died between reserving the row and
    // recording the API result). Reconciled on startup + periodically.
    this.findPendingStmt = this.db.prepare(`
      SELECT id, order_id, market_slug, token_id, condition_id, side, limit_price, requested_shares, window_end_ts
      FROM live_trades WHERE status = 'PENDING' ORDER BY window_end_ts
    `);
    // Recover the true window-open BTC price (the strike) for a slug from the earliest
    // tick the bot recorded for that window. Used on restart so a mid-window restart
    // doesn't reset the strike to the restart-moment spot (which would defeat the
    // maxBtcMovedPct / blockAgainstTrend guards and produce spurious trades).
    this.windowOpenPriceStmt = this.db.prepare(`
      SELECT btc_price_at_window_start AS open FROM ticks
      WHERE market_slug = ? AND btc_price_at_window_start IS NOT NULL AND btc_price_at_window_start > 0
      ORDER BY ts ASC LIMIT 1
    `);
    this.paperStatsStmt = this.db.prepare(`
      SELECT
        COUNT(*) AS trades,
        COALESCE(SUM(win), 0) AS wins,
        COALESCE(SUM(realized_pnl_usd), 0) AS pnl,
        COALESCE(SUM(risk_usd), 0) AS risk
      FROM paper_trades
      WHERE win IS NOT NULL
    `);
    this.liveStatsStmt = this.db.prepare(`
      SELECT
        COUNT(*) AS trades,
        COALESCE(SUM(CASE WHEN (side='UP' AND polymarket_outcome_up=1) OR (side='DOWN' AND polymarket_outcome_up=0) THEN 1 ELSE 0 END), 0) AS wins,
        COALESCE(SUM(realized_pnl_usd), 0) AS pnl,
        COALESCE(SUM(risk_usd), 0) AS risk
      FROM live_trades
      WHERE polymarket_outcome_up IS NOT NULL
    `);
    this.openLiveCountStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM live_trades WHERE status='PLACED'`);
  }

  recordTick(tick: CollectorTick): void {
    this.insertTickStmt.run(tick);
  }

  recordOutcome(windowEndTs: number, marketSlug: string, btcOpen: number, btcClose: number): void {
    this.recordOutcomeStmt.run(windowEndTs, marketSlug, btcOpen, btcClose, btcClose > btcOpen ? 1 : 0);
  }

  recordPolymarketOutcome(windowEndTs: number, polymarketOutcomeUp: 0 | 1 | null): void {
    this.recordPolyOutcomeStmt.run(polymarketOutcomeUp, windowEndTs);
  }

  recordPaperTrade(row: PaperTradeRow): void {
    this.insertPaperStmt.run(row);
  }

  /**
   * Reserve a live order row as PENDING *before* the network call. The synchronous
   * insert closes the restart race: if the process dies during placeBuy, the row is
   * already on disk and hasPlacedLiveOrderForSlug blocks a duplicate. Returns the row id;
   * finalize it with finalizeLiveOrder once the API result is known.
   */
  recordLiveOrderPending(row: {
    windowEndTs: number;
    marketSlug: string;
    tokenId: string;
    conditionId: string | null;
    side: Side;
    limitPrice: number;
    requestedShares: number;
    riskUsd: number;
    placedAtMs: number;
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
  }): number {
    const result = this.insertLiveStmt.run({ ...row, orderId: null, status: "PENDING", error: null });
    return Number(result.lastInsertRowid);
  }

  /** Finalize a reserved row once the API result is known. */
  finalizeLiveOrder(id: number, row: { status: "PLACED" | "FAILED" | "CANCELLED"; orderId: string | null; error: string | null }): void {
    this.finalizeLiveStmt.run({ id, ...row });
  }

  findPendingLiveTrades(): PendingLiveTradeRow[] {
    return this.findPendingStmt.all() as PendingLiveTradeRow[];
  }

  updateLiveTradeSettled(id: number, row: {
    status: "FILLED" | "PARTIAL" | "FAILED" | "CANCELLED";
    filledShares: number | null;
    avgFillPrice: number | null;
    feesUsd: number | null;
    polymarketOutcomeUp: 0 | 1 | null;
    realizedPnlUsd: number | null;
    closedAtMs: number;
    btcPriceAtClose: number | null;
  }): void {
    this.updateLiveSettledStmt.run({ id, ...row });
  }

  findUnsettledLiveTrades(nowMs: number): LiveTradeRow[] {
    return this.findUnsettledStmt.all(nowMs) as LiveTradeRow[];
  }

  findPlacedLiveTradesByWindow(windowEndTs: number): LiveTradeRow[] {
    return this.findPlacedForWindowStmt.all(windowEndTs) as LiveTradeRow[];
  }

  hasPlacedLiveOrderForSlug(marketSlug: string): boolean {
    return !!this.hasPlacedForSlugStmt.get(marketSlug);
  }

  /** Earliest recorded window-open (strike) price for a slug, or null if no prior ticks. */
  recoverWindowOpenPrice(marketSlug: string): number | null {
    const row = this.windowOpenPriceStmt.get(marketSlug) as { open: number } | undefined;
    return row && row.open > 0 ? row.open : null;
  }

  paperStats(): PaperStats {
    const row = this.paperStatsStmt.get() as { trades: number; wins: number; pnl: number; risk: number };
    return {
      trades: row.trades,
      wins: row.wins,
      winRate: row.trades > 0 ? row.wins / row.trades : 0,
      totalPnlUsd: row.pnl,
      totalRiskUsd: row.risk,
      roiPct: row.risk > 0 ? (100 * row.pnl) / row.risk : 0,
    };
  }

  liveStats(): LiveStats {
    const resolved = this.liveStatsStmt.get() as { trades: number; wins: number; pnl: number; risk: number };
    const open = this.openLiveCountStmt.get() as { n: number };
    return {
      trades: resolved.trades,
      wins: resolved.wins,
      winRate: resolved.trades > 0 ? resolved.wins / resolved.trades : 0,
      totalPnlUsd: resolved.pnl,
      totalRiskUsd: resolved.risk,
      roiPct: resolved.risk > 0 ? (100 * resolved.pnl) / resolved.risk : 0,
      openCount: open.n,
    };
  }

  close(): void {
    this.db.close();
  }
}
