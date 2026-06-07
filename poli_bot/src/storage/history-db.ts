import Database from "better-sqlite3";

/**
 * Separate SQLite file for the historical backfill (default ./data/history.sqlite),
 * kept apart from the live ./data/ticks.sqlite so the backfill never touches the
 * live schema/migrations. All timestamps are stored in SECONDS (matching the CLOB
 * prices-history `t` field) to keep joins trivial.
 *
 * Tables:
 *  - hist_windows : one row per resolved 5m window (Gamma-enumerated).
 *  - hist_prices  : the CLOB prices-history points for a window's UP token.
 *  - hist_klines  : 1m BTC klines (Binance) for spot / strike / realized-vol reconstruction.
 */
export function getHistoryDb(path = process.env.HIST_DB_PATH ?? "./data/history.sqlite"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS hist_windows (
      window_end_ts   INTEGER PRIMARY KEY,
      window_start_ts INTEGER NOT NULL,
      slug            TEXT NOT NULL,
      up_token        TEXT NOT NULL,
      down_token      TEXT NOT NULL,
      outcome_up      INTEGER,            -- 1 = UP won, 0 = DOWN won, NULL = tie/unknown
      prices_fetched  INTEGER NOT NULL DEFAULT 0  -- 0 until prices-history pulled (resume flag)
    );
    CREATE TABLE IF NOT EXISTS hist_prices (
      window_end_ts INTEGER NOT NULL,
      t             INTEGER NOT NULL,     -- seconds
      p             REAL NOT NULL,        -- UP-token price (~ P(up))
      PRIMARY KEY (window_end_ts, t)
    );
    CREATE INDEX IF NOT EXISTS idx_hist_prices_win ON hist_prices(window_end_ts);
    CREATE TABLE IF NOT EXISTS hist_klines (
      minute_ts INTEGER PRIMARY KEY,      -- seconds, minute-aligned
      open  REAL NOT NULL,
      high  REAL NOT NULL,
      low   REAL NOT NULL,
      close REAL NOT NULL
    );
  `);
  return db;
}
