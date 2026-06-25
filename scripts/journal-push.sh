#!/usr/bin/env bash
# journal:push — snapshot the live trade journal as ONE rolling commit.
#
# The live engine writes new trades to data/live.sqlite-wal (gitignored). We fold
# that WAL into the tracked data/live.sqlite, then keep history at a single
# "journal …" commit: amend it if the tip already is one, otherwise start a fresh
# one (so a real code commit is never clobbered). The .sqlite snapshot is cumulative
# — every snapshot contains all prior trades — so squashing loses nothing.
set -euo pipefail

# 1. Fold the WAL into the tracked file so git sees the latest trades.
node -e "const d=require('better-sqlite3')('./data/live.sqlite'); d.pragma('wal_checkpoint(TRUNCATE)'); d.close()"

git add data/live.sqlite

# 2. Nothing changed since the last push → done (no empty commit).
if git diff --cached --quiet; then
  echo "journal:push — no new journal data"
  exit 0
fi

MSG="journal $(date -u +%FT%H:%M)"

# 3. Tip already a journal commit → amend it (one rolling commit, force-push the
#    rewrite). Otherwise (e.g. a code commit on top) → start a fresh journal commit.
if git log -1 --pretty=%s | grep -q '^journal '; then
  git commit --amend -m "$MSG"
  git push --force-with-lease
else
  git commit -m "$MSG"
  git push
fi
