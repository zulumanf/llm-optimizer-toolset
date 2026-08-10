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
# The manifest must never hash itself (shell redirection creates the file
# before some shells expand the glob — caught in the spec-059 restore drill).
( cd "$DEST" && find . -maxdepth 1 -type f ! -name MANIFEST.sha256 \
    -exec shasum -a 256 {} + > MANIFEST.sha256 )

# Encryption (spec 059): the dump contains prospect PII; an unencrypted
# copy on a synced folder or bucket is an incident waiting for a leak.
# With BACKUP_ENCRYPTION_KEY set, the whole backup becomes one encrypted
# artifact and the plaintext directory is removed. Production MUST set it;
# the unencrypted default exists for local dev only.
if [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
  echo "▸ encrypting backup…"
  tar -czf "$DEST.tar.gz" -C "$BACKUP_DIR" "$STAMP"
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt     -pass env:BACKUP_ENCRYPTION_KEY     -in "$DEST.tar.gz" -out "$DEST.tar.gz.enc"
  rm -rf "$DEST" "$DEST.tar.gz"
  ARTIFACT="$DEST.tar.gz.enc"
else
  echo "▸ WARNING: BACKUP_ENCRYPTION_KEY unset — backup is PLAINTEXT (dev only)."
  ARTIFACT="$DEST"
fi

# Off-box shipping (spec 059): any uploader works — the command receives
# the artifact path as $1. Examples:
#   BACKUP_UPLOAD_CMD='rclone copy "$1" remote:avos-backups/'
#   BACKUP_UPLOAD_CMD='aws s3 cp "$1" s3://avos-backups/'
if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  echo "▸ shipping off-box…"
  sh -c "$BACKUP_UPLOAD_CMD" upload "$ARTIFACT"
  echo "▸ off-box upload complete."
else
  echo "▸ NOTE: BACKUP_UPLOAD_CMD unset — backup remains on this disk only."
fi

SIZE="$(du -sh "$ARTIFACT" | cut -f1)"
echo "▸ backup complete: $ARTIFACT ($SIZE)"

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
