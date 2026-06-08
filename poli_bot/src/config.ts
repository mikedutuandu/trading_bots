import "dotenv/config";

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing env var: ${key}`);
  return v;
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for ${key}: ${raw}`);
  return n;
}

function int(key: string, fallback: number): number {
  const n = num(key, fallback);
  if (!Number.isInteger(n)) throw new Error(`Expected integer for ${key}: got ${n}`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = (process.env[key] ?? "").toLowerCase().trim();
  if (raw === "") return fallback;
  if (["1", "true", "yes", "y"].includes(raw)) return true;
  if (["0", "false", "no", "n"].includes(raw)) return false;
  throw new Error(`Invalid bool for ${key}: ${raw}`);
}

export const config = {
  polymarket: {
    gammaUrl: env("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com"),
    clobUrl: env("POLYMARKET_CLOB_URL", "https://clob.polymarket.com"),
    rtdsUrl: env("POLYMARKET_RTDS_URL", "wss://ws-live-data.polymarket.com"),
    privateKey: process.env.POLYMARKET_PRIVATE_KEY ?? "",
    funder: process.env.POLYMARKET_FUNDER_ADDRESS ?? "",
  },
  binance: {
    wsUrl: env("BINANCE_WS_URL", "wss://stream.binance.com:9443/ws"),
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },
  priceSource: env("BTC_PRICE_SOURCE", "chainlink") as "chainlink" | "binance",
  collector: {
    dbPath: env("DB_PATH", "./data/ticks.sqlite"),
    tickIntervalMs: int("TICK_INTERVAL_MS", 5000),
    refreshEventsMs: int("REFRESH_EVENTS_MS", 60_000),
    statsLogMs: int("STATS_LOG_MS", 60_000),
    reconcileMs: int("RECONCILE_MS", 60_000),
    settlementPollMs: int("SETTLEMENT_POLL_MS", 10_000),
    settlementPollAttempts: int("SETTLEMENT_POLL_ATTEMPTS", 30),
    polymarketMinShares: int("POLYMARKET_MIN_SHARES", 5),
    liveSizeCapTolerance: num("LIVE_SIZE_CAP_TOLERANCE", 1.5),
    // Reject a tick if the BTC feed hasn't updated in this long — a frozen spot near
    // window close manufactures a fake edge (sigma*sqrt(T)->0 as T->0). Default 30s
    // (6 tick intervals); raise if the feed is legitimately quiet during flat periods.
    maxTickAgeMs: int("MAX_TICK_AGE_MS", 30_000),
    logLevel: env("LOG_LEVEL", "info"),
  },
  paperEnabled: bool("PAPER_ENABLED", true),
  strategy: {
    bankrollUsd: num("STRATEGY_BANKROLL_USD", 1000),
    kellyFraction: num("STRATEGY_KELLY_FRACTION", 0.25),
    minEdge: num("STRATEGY_MIN_EDGE", 0.20),
    maxSpread: num("STRATEGY_MAX_SPREAD", 0.03),
    minRemainingSec: int("STRATEGY_MIN_REMAINING_SEC", 30),
    maxRemainingSec: int("STRATEGY_MAX_REMAINING_SEC", 200),
    maxVol: num("STRATEGY_MAX_VOL", 0.20),
    upOnly: bool("STRATEGY_UP_ONLY", false),
    invertSignal: bool("STRATEGY_INVERT_SIGNAL", false),
    minFvUp: num("STRATEGY_MIN_FV_UP", 0),
    maxEdge: num("STRATEGY_MAX_EDGE", 1),
    minEntryPrice: num("STRATEGY_MIN_ENTRY_PRICE", 0),
    maxEntryPrice: num("STRATEGY_MAX_ENTRY_PRICE", 1),
    marketWeight: num("STRATEGY_MARKET_WEIGHT", 0),
    maxBtcMovedPct: num("STRATEGY_MAX_BTC_MOVED_PCT", 0.003),
    minBtcMovedPct: num("STRATEGY_MIN_BTC_MOVED_PCT", 0),
    requireTrendAgreement: bool("STRATEGY_REQUIRE_TREND_AGREEMENT", false),
  },
  risk: {
    maxOpenPositions: int("RISK_MAX_OPEN_POSITIONS", 3),
    maxRiskPerTradeUsd: num("RISK_MAX_PER_TRADE_USD", 5),
    maxDailyLossUsd: num("RISK_MAX_DAILY_LOSS_USD", 100),
    maxWindowsPerDay: int("RISK_MAX_WINDOWS_PER_DAY", 200),
    stopTradingAtDailyLossPct: num("RISK_STOP_AT_DAILY_LOSS_PCT", 0.10),
  },
  live: {
    // Master switch. When false, the bot only does paper trading. Default: false.
    enabled: bool("LIVE_TRADING", false),
    // Even when enabled, default to dry-run: the LiveTrader logs what it WOULD do but doesn't post.
    // Flip to false ONLY after the smoke tests pass and you're ready to risk real money.
    dryRun: bool("LIVE_DRY_RUN", true),
    // Hard cap for live trades, separate from paper risk. Default $2 — stay tiny.
    maxTradeUsd: num("LIVE_MAX_TRADE_USD", 2),
    // Optional: attach builder code on orders so the user earns builder fee share.
    builderCode: process.env.POLYMARKET_BUILDER_CODE ?? "",
    // CLOB v2 signature type. POLY_1271 is the deposit-wallet model (post-April-2026 default
    // for all new polymarket.com users, including MetaMask logins). Use `npm run find-proxy`
    // to derive the funder address.
    // Options: EOA | POLY_PROXY | POLY_GNOSIS_SAFE | POLY_1271
    signatureType: env("LIVE_SIGNATURE_TYPE", "POLY_1271"),
  },
} as const;
