# Running the bot on the server (pm2)

## Install pm2 (once)

pm2 is an **npm** tool, not an apt package — `apt install pm2` fails with "Unable to
locate package". Install it with npm (you already have npm to run the bot):

```bash
npm install -g pm2
pm2 -v        # verify it's on PATH
```

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

---

## Disk / cleanup (25G server)

Space-eaters: **pm2 logs** and **daily DB backups** (`data/backups/`).

```bash
# see what's big
df -h /
du -ah ~/.pm2/logs /app/trading_bot/data | sort -rh | head

# pm2 logs: clear now, + auto-rotate so they never grow again (one-time)
pm2 flush
pm2 install pm2-logrotate

# old DB backups: keep newest 14, delete the rest
cd /app/trading_bot && ls -t data/backups/*.sqlite | tail -n +15 | xargs -r rm -f

# system junk
sudo journalctl --vacuum-size=200M
sudo apt-get clean && sudo apt-get autoremove -y
```

⚠️ While the bot runs, never delete `data/live.sqlite` or its `-wal` / `-shm` (corrupts the journal). Only `data/backups/` copies are safe to prune.
