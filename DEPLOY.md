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

## Disk / cleanup (small 25G server)

The two things that fill the disk over time: **pm2 logs** (unbounded by default) and **daily DB backups** in `data/backups/` (a full copy of the DB per day, per venue).

### Check what's using space

```bash
df -h /                                            # overall free space
du -sh ~/.pm2/logs/*                               # pm2 logs (usual #1 culprit)
du -sh /app/trading_bot/data/backups               # daily DB backups (grow forever)
du -ah /app/trading_bot | sort -rh | head -20      # top 20 biggest files in the bot dir
```

### Clean pm2 logs (and stop them growing again)

```bash
pm2 flush                                          # clear all pm2 logs right now
# permanent fix — rotate so they never grow unbounded:
pm2 install pm2-logrotate
pm2 set pm2-logrotate:max_size 20M
pm2 set pm2-logrotate:retain 7                     # keep 7 rotated files
pm2 set pm2-logrotate:compress true
```

### Prune old DB backups (keep the newest 14)

```bash
cd /app/trading_bot
ls -t data/backups/live-*.sqlite    | tail -n +15 | xargs -r rm -f
ls -t data/backups/testnet-*.sqlite | tail -n +15 | xargs -r rm -f
```
`tail -n +15` = "everything after the 14 newest". Safe if there are fewer than 14.

### Stray log files

```bash
find /app/trading_bot/data -name '*.log' -size +10M -ls   # find big stray logs
# then remove a specific one after checking it, e.g.: rm /app/trading_bot/data/xsmom-exec.log
```

### ⚠️ NEVER delete while the bot is running

- `data/live.sqlite`, `data/live.sqlite-wal`, `data/live.sqlite-shm` — deleting the WAL/SHM of the *live* database corrupts your trade journal. Only the copies in `data/backups/` are safe to prune (they're complete standalone files).

### System-level cleanup (general)

```bash
sudo journalctl --vacuum-size=200M                 # trim systemd's own logs
sudo apt-get clean && sudo apt-get autoremove -y   # apt cache + old packages (Debian/Ubuntu)
```
