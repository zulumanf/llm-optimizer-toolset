#!/usr/bin/env bash
# Restore from a backup produced by scripts/backup.sh.
#
# Usage: npm run restore -- var/backups/20260729-120000 [target_db]
#
# Restores into a SEPARATE database by default (llm_optimizer_restore) so a
# restore drill never destroys live data. Verify, then promote deliberately.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${1:-}"
TARGET_DB="${2:-llm_optimizer_restore}"
DB_PORT="${BACKUP_DB_PORT:-5433}"

if [ -z "$SRC" ] || [ ! -d "$SRC" ]; then
  echo "usage: npm run restore -- <backup-dir> [target_db]" >&2
  exit 1
fi

echo "▸ verifying backup integrity…"
( cd "$SRC" && shasum -a 256 -c MANIFEST.sha256 )

echo "▸ recreating database $TARGET_DB…"
dropdb -p "$DB_PORT" --if-exists "$TARGET_DB"
createdb -p "$DB_PORT" "$TARGET_DB"

echo "▸ restoring dump…"
pg_restore -p "$DB_PORT" -d "$TARGET_DB" --no-owner "$SRC/database.dump"

echo "▸ row counts in restored database:"
psql -p "$DB_PORT" -d "$TARGET_DB" -c "
  select 'responses' as table, count(*) from responses
  union all select 'mentions', count(*) from mentions
  union all select 'scores', count(*) from scores
  union all select 'claims', count(*) from claims
  union all select 'reports', count(*) from reports;"

if [ -f "$SRC/evidence.tar.gz" ]; then
  echo "▸ evidence archive present. To restore artifacts:"
  echo "    tar -xzf $SRC/evidence.tar.gz -C var/"
fi

echo "▸ restore complete into $TARGET_DB (live database untouched)."
echo "  Verify hashes end-to-end with the integrity check before promoting."
