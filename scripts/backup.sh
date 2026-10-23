#!/usr/bin/env bash
# Nightly backup: Postgres dump + evidence artifacts, compressed and pruned.
#
# Destination: $BACKUP_DIR (default var/backups — SAME DISK, which protects
# against database corruption and bad migrations but NOT disk loss). Point
# BACKUP_DIR at a synced folder (iCloud/Dropbox) or a mounted volume to make
# backups genuinely off-box. See docs/10-security.md.
#
# Usage: npm run backup            (one-off, local dev database)
#        BACKUP_DIR=~/Backups npm run backup
#        BACKUP_DATABASE_URL=postgres://… npm run backup   (any database,
#          e.g. production through the direct — not pooled — connection;
#          spec 151 D2: the default targets the LOCAL dev database only)
set -euo pipefail
cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-var/backups}"
KEEP="${BACKUP_KEEP:-14}"          # retain this many dated backups
DB_NAME="${BACKUP_DB:-llm_optimizer_dev}"
DB_PORT="${BACKUP_DB_PORT:-5433}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DEST="$BACKUP_DIR/$STAMP"

mkdir -p "$DEST"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Ledger (release 151): with BACKUP_RECORD=1 and BACKUP_DATABASE_URL, every
# attempt — success or failure — is recorded in backup_runs on that database
# so the exception queue can alert on a stale backup. Values travel as psql
# variables (:'name'), never interpolated into SQL text. No secret is stored.
record_backup() {
  [ "${BACKUP_RECORD:-0}" = "1" ] && [ -n "${BACKUP_DATABASE_URL:-}" ] || return 0
  local ok="$1" artifact="${2:-}" size="${3:-}" sha="${4:-}" uploaded="${5:-false}" note="${6:-}"
  local encrypted="false"; [ -n "${BACKUP_ENCRYPTION_KEY:-}" ] && encrypted="true"
  printf '%s\n' "insert into backup_runs (started_at, ok, artifact, size_bytes, sha256, destination, encrypted, uploaded, note) values (:'started'::timestamptz, :'ok'::boolean, nullif(:'artifact', ''), nullif(:'size', '')::bigint, nullif(:'sha', ''), nullif(:'dest', ''), :'enc'::boolean, :'up'::boolean, nullif(:'note', ''));" |
    psql "$BACKUP_DATABASE_URL" -q -v ON_ERROR_STOP=1 \
      -v started="$STARTED_AT" -v ok="$ok" -v artifact="$artifact" -v size="$size" -v sha="$sha" \
      -v dest="${BACKUP_DESTINATION_LABEL:-}" -v enc="$encrypted" -v up="$uploaded" -v note="$note" -f - \
    || echo "▸ WARNING: could not record the backup in backup_runs"
}
trap 'record_backup false "" "" "" false "backup script failed (line $LINENO)"' ERR

if [ -n "${BACKUP_DATABASE_URL:-}" ]; then
  # Never echo the URL: it carries the password.
  echo "▸ dumping database from BACKUP_DATABASE_URL…"
  pg_dump "$BACKUP_DATABASE_URL" --format=custom --no-owner --file="$DEST/database.dump"
else
  echo "▸ dumping LOCAL database $DB_NAME (port $DB_PORT) — set BACKUP_DATABASE_URL for any other database…"
  pg_dump -p "$DB_PORT" -d "$DB_NAME" --format=custom --file="$DEST/database.dump"
fi

ARTIFACTS="${ARTIFACT_ROOT:-var}"
if [ -d "${ARTIFACTS}/evidence" ]; then
  echo "▸ archiving evidence artifacts from ${ARTIFACTS}/evidence…"
  tar -czf "$DEST/evidence.tar.gz" -C "${ARTIFACTS}" evidence
else
  echo "▸ no ${ARTIFACTS}/evidence yet — skipping artifacts"
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
UPLOADED=false
if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
  echo "▸ shipping off-box…"
  sh -c "$BACKUP_UPLOAD_CMD" upload "$ARTIFACT"
  UPLOADED=true
  echo "▸ off-box upload complete."
else
  echo "▸ NOTE: BACKUP_UPLOAD_CMD unset — backup remains on this disk only."
fi

SIZE="$(du -sh "$ARTIFACT" | cut -f1)"
echo "▸ backup complete: $ARTIFACT ($SIZE)"
if [ -f "$ARTIFACT" ]; then
  ARTIFACT_BYTES="$(wc -c < "$ARTIFACT" | tr -d ' ')"
  ARTIFACT_SHA="$(shasum -a 256 "$ARTIFACT" | cut -d' ' -f1)"
else
  ARTIFACT_BYTES=""; ARTIFACT_SHA=""
fi
trap - ERR
record_backup true "$(basename "$ARTIFACT")" "$ARTIFACT_BYTES" "$ARTIFACT_SHA" "$UPLOADED" ""

# Prune oldest backups so a tight disk never fills (this machine has run
# out of space before — see DECISIONS/session history). Plaintext backups
# are directories, encrypted ones are *.tar.gz.enc files; both are pruned
# (spec 151 D2: encrypted files were previously never pruned). Names are
# timestamps, so a lexical sort is chronological.
list_backups() {
  find "$BACKUP_DIR" -maxdepth 1 -mindepth 1 \( -type d -o -name '*.tar.gz.enc' \) | sort
}
COUNT="$(list_backups | wc -l | tr -d ' ')"
if [ "$COUNT" -gt "$KEEP" ]; then
  REMOVE=$((COUNT - KEEP))
  echo "▸ pruning $REMOVE backup(s) beyond the $KEEP most recent"
  list_backups | head -n "$REMOVE" | while read -r old; do rm -rf "$old"; done
fi

echo "▸ retained backups:"
list_backups | tail -5
