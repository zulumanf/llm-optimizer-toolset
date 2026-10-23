#!/bin/zsh
# Reads the bearer key from the login Keychain; never stored on disk.
set -euo pipefail
export RF_OLLAMA_KEY="$(/usr/bin/security find-generic-password -s rf-ollama-proxy -a "$USER" -w)"
if [[ ${#RF_OLLAMA_KEY} -lt 32 ]]; then echo "rf-ollama: bearer key missing from Keychain" >&2; exit 1; fi
exec /opt/homebrew/bin/caddy run --config "$HOME/.config/rf-ollama/Caddyfile" --adapter caddyfile
