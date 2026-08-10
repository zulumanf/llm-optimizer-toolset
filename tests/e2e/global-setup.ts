/**
 * Creates the e2e database if missing, then seeds it through the real
 * services (scripts/seed-e2e.ts). Runs once per `playwright test`.
 *
 * Hard-won rules (backlog #18 — the CI "hang"):
 *  - `-w` on createdb: NEVER let libpq prompt for a password. On a runner
 *    whose postgres requires auth, the prompt reads /dev/tty and blocks
 *    forever — silently, because stderr was discarded.
 *  - `timeout` on every child: execSync is SYNCHRONOUS and blocks the whole
 *    Node event loop, so playwright's own globalTimeout cannot fire while a
 *    child hangs. The child timeouts are therefore the only real guard.
 *  - stderr stays visible. Silence was the expensive part.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { E2E_DB } from "../../playwright.config";

const ROOT = join(__dirname, "..", "..");

export default function globalSetup(): void {
  console.log("[e2e-setup] ensuring database exists…");
  try {
    execSync(`createdb -w -h localhost -p 5433 llm_optimizer_e2e`, {
      timeout: 15_000,
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, PGCONNECT_TIMEOUT: "10" },
    });
  } catch {
    // Exists already, or the service created it (CI) — the seed's own
    // connection is the real check and fails loudly if the DB is absent.
  }
  console.log("[e2e-setup] seeding through the real services…");
  execSync(`npx tsx --tsconfig tsconfig.json scripts/seed-e2e.ts`, {
    cwd: ROOT,
    stdio: "inherit",
    timeout: 240_000,
    env: {
      ...process.env,
      DATABASE_URL: E2E_DB,
      AUTH_MODE: "dev",
      ALLOW_MOCK_PROVIDER: "1",
      ALLOW_MOCK_SCORING: "1",
      PGCONNECT_TIMEOUT: "10",
    },
  });
  console.log("[e2e-setup] done");
}
