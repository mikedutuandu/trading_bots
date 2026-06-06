/** Small shared helpers used across the engine, storage and scripts. */

const DAY_MS = 86_400_000;

/** Resolve after `ms` milliseconds. */
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** UTC calendar day as YYYY-MM-DD — used for per-day dedup keys. */
export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** UTC midnight (ms epoch) of the day containing `ms`. */
export const dayStartMs = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
