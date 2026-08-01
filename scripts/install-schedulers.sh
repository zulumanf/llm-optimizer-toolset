#!/usr/bin/env bash
#
# Install the platform's launchd schedulers (B2, docs/pilot-launch-plan.md).
#
#   ./scripts/install-schedulers.sh            install / refresh all agents
#   ./scripts/install-schedulers.sh uninstall  remove them
#
# Agents (all curl a bearer-authenticated cron route on localhost):
#   com.avos.weekly-cycle          Mon 09:00        /api/cron/weekly-cycle
#   com.avos.automation-heartbeat  every 5 min      /api/cron/automation
#   com.avos.automation-health     daily 07:00      /api/cron/automation?health=true
#   com.avos.notifications         every 15 min     /api/cron/notifications
#
# Honesty caveat (same as the old weekly-baseline template): these fire only
# while this machine is awake AND `npm run app` is serving, with
# `npm run worker` running to consume what the routes enqueue. launchd runs a
# missed StartCalendarInterval once on wake, but a machine that is off on
# Monday morning starts nothing — the stale_client notification (>=14 days
# without a run) is the tripwire, and the durable fix is hosted deployment.
#
# The legacy com.avos.weekly-baseline agent is removed if present: the
# weekly cycle starts (or reuses) the baseline run itself, and one entry
# point is easier to reason about than two.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
PORT="${APP_PORT:-3000}"
LABELS=(
  com.avos.weekly-cycle
  com.avos.automation-heartbeat
  com.avos.automation-health
  com.avos.notifications
)

unload_agent() {
  local label="$1"
  local plist="$AGENTS_DIR/$label.plist"
  if [ -f "$plist" ]; then
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    echo "removed  $label"
  fi
}

if [ "${1:-install}" = "uninstall" ]; then
  for label in "${LABELS[@]}" com.avos.weekly-baseline; do
    unload_agent "$label"
  done
  exit 0
fi

# Read CRON_SECRET from .env without exporting the rest of it.
CRON_SECRET="$(grep -E '^CRON_SECRET=' "$REPO_DIR/.env" | head -1 | cut -d= -f2-)"
if [ -z "$CRON_SECRET" ]; then
  echo "CRON_SECRET is empty in $REPO_DIR/.env — set it first." >&2
  exit 1
fi

mkdir -p "$AGENTS_DIR"

# $1 label · $2 path (with query) · $3 schedule-xml
write_agent() {
  local label="$1" path="$2" schedule="$3"
  local plist="$AGENTS_DIR/$label.plist"
  launchctl unload "$plist" 2>/dev/null || true
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/curl</string>
    <string>-fsS</string>
    <string>--max-time</string>
    <string>290</string>
    <string>-X</string>
    <string>POST</string>
    <string>-H</string>
    <string>Authorization: Bearer $CRON_SECRET</string>
    <string>http://localhost:$PORT$path</string>
  </array>
$schedule
  <key>StandardOutPath</key>
  <string>/tmp/avos-${label#com.avos.}.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/avos-${label#com.avos.}.err</string>
</dict>
</plist>
EOF
  launchctl load "$plist"
  echo "installed  $label -> $path"
}

# Retire the legacy single-purpose agent before installing the successors.
unload_agent com.avos.weekly-baseline

write_agent com.avos.weekly-cycle "/api/cron/weekly-cycle" '  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>1</integer>
    <key>Hour</key><integer>9</integer>
    <key>Minute</key><integer>0</integer>
  </dict>'

write_agent com.avos.automation-heartbeat "/api/cron/automation" '  <key>StartInterval</key>
  <integer>300</integer>'

write_agent com.avos.automation-health "/api/cron/automation?health=true" '  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>7</integer>
    <key>Minute</key><integer>0</integer>
  </dict>'

write_agent com.avos.notifications "/api/cron/notifications" '  <key>StartInterval</key>
  <integer>900</integer>'

echo
echo "Loaded agents:"
launchctl list | grep com.avos || true
echo
echo "Remember: these need 'npm run app' serving on :$PORT and 'npm run worker' running."
