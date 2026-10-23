# Internal inference host (Ollama on Francisco's Mac)

Production's worker reaches the open-weight models at **`https://rf-ollama.tail390f0b.ts.net`** (Tailscale Funnel). Set up on 2026-10-23.

The setup is three layers:

1. **Ollama.** Runs as the desktop app and listens on `127.0.0.1:11434` only. The models the app routes to (`INTERNAL_TASK_TARGETS`) are `qwen3:8b`, `gpt-oss:20b` and `qwen3:30b`.
2. **Auth proxy (Caddy).** Listens on `127.0.0.1:11435`. It is deny-by-default: it serves only `POST /api/chat` and `GET /api/version`, and only with the bearer key. Everything else gets `401 {"error":"unauthorized"}`, including `/api/tags`, `/api/pull`, `/api/delete` and `/api/generate`, *even with the key*. The request body cap is 8 MB, and the admin API is off. Access log: `~/Library/Logs/rf-ollama/access.log` (Caddy redacts `Authorization`).
3. **Tailscale Funnel.** Gives the proxy a public HTTPS address (a Let's Encrypt certificate managed by Tailscale). `tailscaled` runs in userspace mode as a login service, so it needs no admin rights. The Funnel configuration persists across restarts.

| Login service (`~/Library/LaunchAgents`) | Purpose |
|---|---|
| `com.recommendedfirst.ollama-proxy` | Caddy, started by `start-proxy.sh`, which reads the key from the Keychain at launch |
| `com.recommendedfirst.tailscaled` | Tailscale daemon, userspace networking; state in `~/.local/share/rf-tailscale` (mode 700) |
| `com.recommendedfirst.caffeinate` | `caffeinate -s`: no system sleep while on AC power |

The files in this directory are templates of the installed ones. `$HOME` and `__HOME__` stand for the home directory.

## The key

The key is 256-bit random, stored in the macOS login Keychain as service `rf-ollama-proxy`. It is never in a file, never in this repo, never printed.

- **To set it on Railway (worker service only):**
  ```
  security find-generic-password -s rf-ollama-proxy -a "$USER" -w | pbcopy
  ```
  Then paste it as `OLLAMA_API_KEY`, and set `OLLAMA_URL=https://rf-ollama.tail390f0b.ts.net`. The web process never calls Ollama.
- **To rotate it:**
  ```
  security add-generic-password -U -s rf-ollama-proxy -a "$USER" -w "$(openssl rand -hex 32)"
  launchctl kickstart -k gui/$(id -u)/com.recommendedfirst.ollama-proxy
  ```
  Then update `OLLAMA_API_KEY` on Railway. Until both sides match, calls fail closed with `provider_auth`.

## Operating it

```
ts(){ tailscale --socket=$HOME/.local/share/rf-tailscale/tailscaled.sock "$@"; }
ts status; ts funnel status               # online? Funnel on?
ts funnel --https=443 off                 # STOP public access immediately
ts funnel --bg --https=443 http://127.0.0.1:11435   # start it again
launchctl print gui/$(id -u)/com.recommendedfirst.ollama-proxy | grep state
ollama ps                                  # loaded models
```

**Testing from this Mac.** Calling the Funnel address from this same Mac loops out and back. That fails intermittently, especially after a network change. Test from outside the Mac instead; a request without the key must get the JSON 401.

## Failure modes (all fail closed)

The app never falls back to OpenAI or to a heuristic.

| Situation | Effect |
|---|---|
| Mac asleep, offline or unplugged | Meeting summaries, support triage, claim extraction and contradiction detection fail (`internal`), and the affected runs safe-stop. |
| Wrong or missing key | `provider_auth`. |
| A call takes longer than 280 s | Aborted (`OLLAMA_REQUEST_TIMEOUT_MS`), and the request fails closed. |
| 36 GB RAM | Only one large model stays resident; a switch costs a 2–5 s load (measured). That is acceptable at this volume. |

Contractual measurement never uses this host (`tests/unit/measurement-provider-boundary.test.ts`).

## Verified 2026-10-23

- **From the outside internet:** no key → 401; key on `/api/pull` → 401; `/api/chat` (`qwen3:8b`) → 200 in 9.7 s. That test used a temporary key, which was then deleted and confirmed refused.
- **Locally, through the app's own caller:** all three models answer (4–8 s).
- **After a `tailscaled` restart:** Funnel came back on its own, and an outside request got 401 again.
