# Running the bot on the server (pm2)

## Dead-simple (3 commands on the server)

```bash
cd /app/trading_bot
pm2 start npm --name trading-bot -- run live
pm2 save        # remember it across reboots
pm2 startup     # prints one sudo command — run it once, for boot-resurrect
```

## Day-to-day

```bash
pm2 status
pm2 logs trading-bot          # live logs
pm2 restart trading-bot       # after a git pull
pm2 stop trading-bot
```

---

Notes:
- **One instance only** — don't also run `npm run live` in a terminal (single-writer SQLite).
- Restart-safe: on (re)start the bot reconciles open positions against the exchange, so a kill/restart won't orphan or double-trade.
- `pm2 save` + `pm2 startup` = it trades real money automatically on every reboot; the `.env` `ALLOW_LIVE`/`CONFIRM_LIVE` gates are what gate that.
- For crash-loop protection (`max_restarts`, `restart_delay`), use an `ecosystem.config.cjs` instead of the bare `pm2 start` — ask if you want it.
