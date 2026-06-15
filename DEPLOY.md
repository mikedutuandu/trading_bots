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

## Journal sync (server ↔ your Mac)

The live trade journal (`data/live.sqlite`) travels through git. Push it from the server, view it on your Mac.

**On the SERVER** — push the latest journal whenever you want to sync:

```bash
npm run journal:push    # folds the WAL into the file (so it's current), commits, pushes
```

**On your MAC** — pull and view (read-only; the bot does NOT run here):

```bash
git pull                                          # get the server's latest journal
rm -f data/live.sqlite-wal data/live.sqlite-shm   # clear stale WAL sidecars (else "malformed")
npm run dashboard:live                            # http://localhost:8788
```

⚠️ The `rm` is **Mac-only** — never run it on the server (it would corrupt the DB the engine is writing).
If `git pull` complains about local changes to `data/live.sqlite`, run `git checkout -- data/live.sqlite` first.

> Note: `.env` is gitignored, so config never syncs through git — server and Mac each have their own `.env`.

### Real-time dashboard — run it on the server (no sync lag)

The pull-to-Mac dashboard above is only as fresh as the last `journal:push`. For *live* data, run the dashboard **on the server** under pm2 — it reads the live DB directly (safe: SQLite WAL allows the engine to write while the dashboard reads):

```bash
pm2 start npm --name dashboard -- run dashboard:live   # serves localhost:8788 on the server
pm2 save
```

Manage it like the bot: `pm2 logs dashboard` · `pm2 restart dashboard` · `pm2 stop dashboard`.

View it from your Mac over an SSH tunnel (the dashboard binds to localhost — keep it off the public internet):

```bash
ssh -L 8788:localhost:8788 root@<server-ip>
# then open http://localhost:8788 in your Mac browser → real-time, no pull needed
```

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
