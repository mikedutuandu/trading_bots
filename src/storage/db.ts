import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

let db: Database.Database | null = null;

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS candles (
  symbol     TEXT    NOT NULL,
  interval   TEXT    NOT NULL,
  open_time  INTEGER NOT NULL,
  open       REAL    NOT NULL,
  high       REAL    NOT NULL,
  low        REAL    NOT NULL,
  close      REAL    NOT NULL,
  volume     REAL    NOT NULL,
  close_time INTEGER NOT NULL,
  PRIMARY KEY (symbol, interval, open_time)
);

CREATE TABLE IF NOT EXISTS trades (
  id           TEXT PRIMARY KEY,
  symbol       TEXT    NOT NULL,
  side         TEXT    NOT NULL,
  playbook     TEXT    NOT NULL,
  setup        TEXT    NOT NULL,
  timeframe    TEXT    NOT NULL,
  entry_price  REAL    NOT NULL,
  stop_price   REAL    NOT NULL,
  qty          REAL    NOT NULL,
  notional     REAL    NOT NULL,
  leverage     REAL    NOT NULL,
  risk_usdt    REAL    NOT NULL,
  r_planned    REAL    NOT NULL,
  tp1          REAL    NOT NULL,
  tp2          REAL    NOT NULL,
  tp3          REAL    NOT NULL,
  status       TEXT    NOT NULL,
  exit_price   REAL,
  close_reason TEXT,
  r_realized   REAL,
  gross_pnl    REAL,
  commission   REAL,
  funding      REAL,
  net_pnl      REAL,
  opened_at    INTEGER NOT NULL,
  closed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

CREATE TABLE IF NOT EXISTS equity_snapshots (
  ts             INTEGER PRIMARY KEY,
  equity         REAL NOT NULL,
  available      REAL NOT NULL,
  margin_used    REAL NOT NULL,
  open_positions INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS universe_snapshots (
  ts      INTEGER NOT NULL,
  symbol  TEXT    NOT NULL,
  rank    INTEGER NOT NULL,
  PRIMARY KEY (ts, symbol)
);

CREATE TABLE IF NOT EXISTS funding_rates (
  symbol       TEXT    NOT NULL,
  funding_time INTEGER NOT NULL,
  rate         REAL    NOT NULL,
  PRIMARY KEY (symbol, funding_time)
);

-- Live/paper engine state. One row per open position; survives restarts so the
-- engine can reconcile against the exchange instead of trusting memory.
CREATE TABLE IF NOT EXISTS live_positions (
  symbol             TEXT PRIMARY KEY,
  trade_id           TEXT    NOT NULL,
  side               TEXT    NOT NULL,
  playbook           TEXT    NOT NULL,
  setup              TEXT    NOT NULL,
  entry              REAL    NOT NULL,
  stop               REAL    NOT NULL,
  tp1                REAL    NOT NULL,
  tp2                REAL    NOT NULL,
  tp3                REAL    NOT NULL,
  qty_total          REAL    NOT NULL,
  qty_remaining      REAL    NOT NULL,
  qty_tp1            REAL    NOT NULL,
  qty_tp2            REAL    NOT NULL,
  tp1_hit            INTEGER NOT NULL,
  tp2_hit            INTEGER NOT NULL,
  trail_active       INTEGER NOT NULL,
  trail_extreme      REAL    NOT NULL,
  risk_usdt          REAL    NOT NULL,
  notional           REAL    NOT NULL,
  r_planned          REAL    NOT NULL,
  gross_pnl          REAL    NOT NULL,
  commission         REAL    NOT NULL,
  funding            REAL    NOT NULL,
  protective_stop_id TEXT,
  opened_at          INTEGER NOT NULL,
  opened_at_bar_time INTEGER NOT NULL
);

-- Generic key/value for engine bookkeeping (e.g. last processed candle time).
CREATE TABLE IF NOT EXISTS engine_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(dirname(config.storage.dbPath), { recursive: true });
  db = new Database(config.storage.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(MIGRATIONS);
  logger.debug(`db ready at ${config.storage.dbPath}`);
  return db;
}

export function closeDb(): void {
  db?.close();
  db = null;
}
