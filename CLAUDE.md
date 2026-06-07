# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This repo is a **workspace of two independent trading bots**. They share no code and no dependencies — each is a self-contained Node/TypeScript project with its own `package.json`, `node_modules`, `data/`, `.env`, and a detailed `CLAUDE.md`. **Always `cd` into the bot directory before running anything; npm scripts and relative `DB_PATH`s assume that working directory.**

| Directory | Bot | Read first |
|---|---|---|
| [poli_bot/](poli_bot/) | Polymarket **BTC 5m up/down** prediction-market bot. Buy-only; Black-Scholes fair value blended with the market, quarter-Kelly sizing; positions resolve at window close. Live. | [poli_bot/CLAUDE.md](poli_bot/CLAUDE.md), [poli_bot/DOCS.md](poli_bot/DOCS.md) |
| [binance_bot/](binance_bot/) | Binance **USDT-M perpetual futures** long/short bot. R-based risk, `trend-pullback` only; TP ladder + trailing exit. Reverse-engineered, marginal edge, in testnet forward-test. | [binance_bot/CLAUDE.md](binance_bot/CLAUDE.md), [binance_bot/README.md](binance_bot/README.md) |

The per-bot `CLAUDE.md` files are the source of truth for that bot's commands, architecture, and the non-obvious invariants (execution model, restart-safety, DB roles, exchange quirks). Defer to them — this file only covers what the two have in common.

## Shared conventions (both bots)

These hold identically in both projects; learn them once.

- **Runtime:** Node ≥20, ESM (`"type": "module"`), TypeScript run directly via `tsx` (no build step at runtime). `npm run build` (`tsc` → `dist/`) exists but isn't used to run.
- **`tsx`-direct + ESM means imports use `.js` suffixes on `.ts` sources** (e.g. `import { x } from "./foo.js"` where the file is `foo.ts`). Preserve this when adding files.
- **`npm run typecheck` (`tsc --noEmit`) is the ONLY static check** — there is no test runner and no linter in either bot. Run it after every change.
- **`npm run collect` is the main long-running process** in both (different jobs — Polymarket loop vs. kline downloader — but the same entry-point name).
- **`npm run backtest`** replays recorded history through the *same* decision/sizing code the live path uses. The cardinal discipline in both bots: **nothing goes live until it clears the backtest gate (+EV after fees, out-of-sample); keep real size tiny.** Both edges are marginal.
- **Storage:** `better-sqlite3`, one or more `.sqlite` files under `data/`. Schema migrations live inline at the top of the store/`getDb` constructor (`CREATE TABLE IF NOT EXISTS` / `PRAGMA table_info` + `ALTER TABLE ADD COLUMN`); SQLite is append-only by convention, so restarting `collect` is safe.
- **Config:** all tunables flow `env → src/config.ts → typed config`. Add new tunables there; don't read `process.env` directly in feature code.
- **Logger** is the tiny hand-rolled one in `src/logger.ts` — don't add winston/pino. `LOG_LEVEL=debug` for detail (signal rejections, etc.).
- **Telegram** (`src/notifications/telegram.ts`) is a no-op unless `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are set, and must never throw into the trading path.
- `strict` + `noUncheckedIndexedAccess` are on in both — array/index access is `T | undefined`.
- Secrets live in each bot's `.env` (gitignored, alongside a committed `.env.example`). The root `.gitignore` also excludes `node_modules/`, `data/`, `*.sqlite*`, and IDE/OS noise.
