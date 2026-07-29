#!/usr/bin/env bash
# Nightly backup: Postgres dump + evidence artifacts, compressed and pruned.
#
# Destination: $BACKUP_DIR (default var/backups — SAME DISK, which protects
# against database corruption and bad migrations but NOT disk loss). Point
# BACKUP_DIR at a synced folder (iCloud/Dropbox) or a mounted volume to make
# backups genuinely off-box. See docs/10-security.md.
#
# Usage: npm run backup            (one-off)
#        BACKUP_DIR=~/Backups npm run backup
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-var/backups}"
KEEP="${BACKUP_KEEP:-14}"          # retain this many dated backups
DB_NAME="${BACKUP_DB:-llm_optimizer_dev}"
DB_PORT="${BACKUP_DB_PORT:-5433}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"

mkdir -p "$DEST"

echo "▸ dumping database $DB_NAME (port $DB_PORT)…"
pg_dump -p "$DB_PORT" -d "$DB_NAME" --format=custom --file="$DEST/database.dump"

if [ -d var/evidence ]; then
  echo "▸ archiving evidence artifacts…"
  tar -czf "$DEST/evidence.tar.gz" -C var evidence
else
  echo "▸ no var/evidence yet — skipping artifacts"
fi

# Integrity record: hashes of the backup files themselves, so a restore can
# be verified the same way client evidence packages are (evidence spec).
( cd "$DEST" && shasum -a 256 ./* > MANIFEST.sha256 )

SIZE="$(du -sh "$DEST" | cut -f1)"
echo "▸ backup complete: $DEST ($SIZE)"

# Prune oldest backups so a tight disk never fills (this machine has run
# out of space before — see DECISIONS/session history)
COUNT="$(find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$KEEP" ]; then
  REMOVE=$((COUNT - KEEP))
  echo "▸ pruning $REMOVE backup(s) beyond the $KEEP most recent"
  find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d | sort | head -n "$REMOVE" |
    while read -r old; do rm -rf "$old"; done
fi

echo "▸ retained backups:"
find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 -type d | sort | tail -5
