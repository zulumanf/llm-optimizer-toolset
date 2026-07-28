#!/usr/bin/env bash
# One-command dev environment: Postgres + migrations + worker + app.
# Usage: npm run app   (Ctrl+C stops everything)
set -euo pipefail
cd "$(dirname "$0")/.."

if ! pg_isready -p 5433 -q 2>/dev/null; then
  echo "▸ starting postgresql@14 (port 5433)…"
  /opt/homebrew/opt/postgresql@14/bin/pg_ctl \
    -D /opt/homebrew/var/postgresql@14 \
    -l /opt/homebrew/var/log/postgresql@14.log start
  sleep 1
fi

echo "▸ applying migrations…"
npm run db:migrate --silent

trap 'kill 0' EXIT
echo "▸ starting worker…"
npm run worker &
echo "▸ starting app → http://localhost:3000"
npm run dev
