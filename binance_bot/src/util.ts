/** Small shared helpers used across the engine, storage and scripts. */

const DAY_MS = 86_400_000;

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** UTC calendar day as YYYY-MM-DD — used for per-day dedup keys. */
export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** UTC midnight (ms epoch) of the day containing `ms`. */
export const dayStartMs = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** A position quantity at or below this is float dust — treat as flat. */
export const QTY_DUST = 1e-9;

/** Timeframe string ("15m", "1h", "1d", "1w") → milliseconds. */
export function intervalMs(timeframe: string): number {
  const m = /^(\d+)([mhdw])$/.exec(timeframe);
  if (!m) throw new Error(`Unsupported timeframe: ${timeframe}`);
  const n = Number(m[1]);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2]!]!;
  return n * unit;
}
