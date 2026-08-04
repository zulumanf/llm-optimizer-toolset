/**
 * Creates the e2e database if missing, then seeds it through the real
 * services (scripts/seed-e2e.ts). Runs once per `playwright test`.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { E2E_DB } from "../../playwright.config";

const ROOT = join(__dirname, "..", "..");

export default function globalSetup(): void {
  execSync(`createdb -h localhost -p 5433 llm_optimizer_e2e 2>/dev/null || true`, {
    shell: "/bin/bash",
  });
  execSync(`npx tsx --tsconfig tsconfig.json scripts/seed-e2e.ts`, {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: E2E_DB,
      AUTH_MODE: "dev",
      ALLOW_MOCK_PROVIDER: "1",
    },
  });
}
