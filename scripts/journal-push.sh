#!/usr/bin/env bash
# Push the live trade journal to git. Run from cron on the box that runs the bot:
#   5 0 * * * /app/trading_bot/scripts/journal-push.sh >> /var/log/journal-push.log 2>&1
# The Mac side just `git pull`s and reads data/live.sqlite with the usual tools.
set -euo pipefail
cd "$(dirname "$0")/.."

# Fold the WAL sidecar into the main file so the committed copy is complete
# (in WAL mode the freshest transactions live in live.sqlite-wal, which stays
# gitignored — without this line every commit would lag the last checkpoint).
sqlite3 data/live.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"

git add data/live.sqlite
# No journal changes since the last push (e.g. zero trades) → nothing to commit.
if git diff --cached --quiet; then
  echo "$(date -u +%FT%TZ) journal unchanged — skipping"
  exit 0
fi
git commit -m "journal $(date -u +%F)"
# MERGE, not rebase: the bot keeps writing live.sqlite between our add and this pull,
# so the tree is perpetually dirty — rebase refuses outright, merge proceeds as long
# as the incoming commits don't touch the journal (they're code pushes from the Mac;
# by convention only THIS box commits the journal).
git pull --no-rebase --no-edit
git push
echo "$(date -u +%FT%TZ) journal pushed"
