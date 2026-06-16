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

/** Strict env boolean: accepts 1/true/yes/y and 0/false/no/n (any case), THROWS on
 *  anything else. Exported so runtime flags (DRY_RUN etc.) can't silently flip the
 *  dangerous way on a casing typo (e.g. DRY_RUN=True under exact-match → real orders). */
export function envBool(key: string, fallback: boolean): boolean {
  const raw = (process.env[key] ?? "").toLowerCase().trim();
  if (raw === "") return fallback;
  if (["1", "true", "yes", "y"].includes(raw)) return true;
  if (["0", "false", "no", "n"].includes(raw)) return false;
  throw new Error(`Invalid bool for ${key}: ${raw}`);
}
const bool = envBool;

function list(key: string): string[] {
  return (process.env[key] ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

export type MonitorReversalMode = "off" | "warn" | "exit";

function monitorMode(): MonitorReversalMode {
  const v = (process.env.MONITOR_REVERSAL_MODE ?? "warn").toLowerCase().trim();
  if (v === "off" || v === "warn" || v === "exit") return v;
  throw new Error(`Invalid MONITOR_REVERSAL_MODE: ${v} (expected off | warn | exit)`);
}

export type Mode = "backtest" | "paper" | "live";
export type UniverseMode = "dynamic" | "static";

// Stablecoins / wrapped / index products we never want to trade as directional perps.
const DEFAULT_DENYLIST = [
  "USDCUSDT",
  "FDUSDUSDT",
  "TUSDUSDT",
  "BTCDOMUSDT",
  "USDPUSDT",
  "EURUSDT",
];

export const config = {
  mode: env("MODE", "backtest") as Mode,
  allowLive: bool("ALLOW_LIVE", false),

  binance: {
    // Mainnet keys (used by `npm run live`).
    apiKey: process.env.BINANCE_API_KEY ?? "",
    apiSecret: process.env.BINANCE_API_SECRET ?? "",
    // Test-venue keys (used by `npm run testnet`). Fall back to the mainnet keys
    // so a single-key setup keeps working; set these when the test venue needs
    // its own keys (e.g. testnet.binancefuture.com).
    testnetApiKey: process.env.BINANCE_TESTNET_API_KEY || process.env.BINANCE_API_KEY || "",
    testnetApiSecret: process.env.BINANCE_TESTNET_API_SECRET || process.env.BINANCE_API_SECRET || "",
    // Mainnet host — used for market data / backtest and for the `live` run.
    baseUrl: env("BINANCE_BASE_URL", "https://fapi.binance.com"),
    wsUrl: env("BINANCE_WS_URL", "wss://fstream.binance.com"),
    // Test venue — used by the `testnet` run (risk-free real orders). The Binance
    // futures sandbox is now "Demo Trading" (demo-fapi.binance.com); the old
    // testnet.binancefuture.com redirects here. Realistic prices, but it rejects
    // STOP_MARKET (-4120) so the bot manages stops on candle close.
    testnetBaseUrl: env("BINANCE_TESTNET_BASE_URL", "https://demo-fapi.binance.com"),
    testnetWsUrl: env("BINANCE_TESTNET_WS_URL", "wss://demo-fstream.binance.com"),
    recvWindow: int("BINANCE_RECV_WINDOW", 5000),
  },

  storage: {
    dbPath: env("DB_PATH", "./data/binance.sqlite"),
  },

  risk: {
    riskPct: num("RISK_PCT", 0.01),
    // Fixed USDT risk per trade. When > 0 it OVERRIDES riskPct — use it for the
    // first real-money phase (e.g. RISK_USDT=1 to risk ~1 USDT/trade).
    riskUsdt: num("RISK_USDT", 0),
    leverage: num("LEVERAGE", 10),
    maxOpenPositions: int("MAX_OPEN_POSITIONS", 3),
    // Cap concurrent SAME-SIDE positions (0 = off). Anti-correlation: stops the book
    // going all-long/all-short into a regime turn (the 2026-06 all-long −1R stop cluster).
    // Walk-forward validated at 3 (with maxOpen=4): OOS PF 1.10→1.21, net $122→$234, DD
    // 32%→26%, fewer −1R stops. The ONLY exit/entry tweak of ~10 tested that helped.
    maxPerSide: int("MAX_PER_SIDE", 0),
    maxDailyLossPct: num("MAX_DAILY_LOSS_PCT", 0.05),
    takerFee: num("TAKER_FEE", 0.0004),
    slippageBps: num("SLIPPAGE_BPS", 2),
    // Hard ceilings (0 = disabled). Belt-and-suspenders caps for live money.
    maxTradeRiskUsdt: num("MAX_TRADE_RISK_USDT", 0),
    maxNotionalPerTrade: num("MAX_NOTIONAL_PER_TRADE", 0),
    // Proportional cap: notional/leg <= equity x this fraction — self-scales as the
    // account grows/shrinks (an absolute cap goes stale). Both caps can be active;
    // the tighter one wins. 0 = off.
    maxNotionalPct: num("MAX_NOTIONAL_PCT", 0),
  },

  strategy: {
    timeframe: env("TIMEFRAME", "1h"),
  },

  // Intra-candle guardian: a fast loop that checks open positions between the
  // hourly ticks (live-only safety overlay — NOT modelled by the backtest).
  monitor: {
    enabled: bool("MONITOR_ENABLED", true),
    intervalMin: num("MONITOR_INTERVAL_MIN", 1), // how often to check open positions (minutes)
    reversalMode: monitorMode(), // off | warn | exit — what to do on a faster-TF trend flip
    reversalTf: env("MONITOR_REVERSAL_TF", "15m"), // timeframe for the EMA50/EMA200 reversal check
    summaryMin: num("MONITOR_SUMMARY_MIN", 15), // periodic Telegram open-positions summary; 0 = off
    heartbeatHours: num("HEARTBEAT_HOURS", 0), // Telegram the tick-done line every N hours (proof of life when flat); 0 = off
    // Skip entries whose faster-TF trend is ALREADY against the signal at fill time —
    // (an ENTRY gate, kept under monitor because it derives from the monitor.s reversal verdict)
    // the exit-mode guardian would kill them within a minute (open→REVERSAL_CLOSE churn).
    // Same env drives the LIVE_SIM replay, so live and backtest stay in lockstep.
    entryAlign: bool("ENTRY_ALIGN", false),
  },

  ops: {
    // Second key (besides ALLOW_LIVE) required to actually send mainnet orders.
    confirmLive: bool("CONFIRM_LIVE", false),
    dashboardPort: int("DASHBOARD_PORT", 8787),
    // Display timezone for the dashboard dates/day-buckets (hours east of UTC).
    // Engine internals (kill-switch day, time-stops) stay UTC regardless.
    dashboardTzHours: num("DASHBOARD_TZ_HOURS", 7),
    backupDir: env("BACKUP_DIR", "./data/backups"),
  },

  notifications: {
    telegramToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },

  universe: {
    mode: env("UNIVERSE_MODE", "dynamic") as UniverseMode,
    size: int("UNIVERSE_SIZE", 50),
    min24hVolume: num("MIN_24H_VOLUME", 50_000_000),
    symbols: list("SYMBOLS"),
    denylist: [...DEFAULT_DENYLIST, ...list("DENYLIST")],
  },

  logLevel: env("LOG_LEVEL", "info"),
} as const;
