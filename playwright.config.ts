/**
 * UI/E2E layer (spec 049). Fully isolated from dev: own database
 * (llm_optimizer_e2e), own port (3100), own build dir (.next-e2e) — a live
 * dev server on :3000 is never touched. One worker: the suite shares one
 * seeded database and mutating flows must stay deterministic.
 */
import { defineConfig } from "@playwright/test";

export const E2E_DB =
  process.env.E2E_DATABASE_URL ?? "postgres://localhost:5433/llm_optimizer_e2e";
const PORT = 3100;

const env = {
  DATABASE_URL: E2E_DB,
  AUTH_MODE: "dev",
  ALLOW_MOCK_PROVIDER: "1",
  APP_URL: `http://localhost:${PORT}`,
  NEXT_DIST_DIR: ".next-e2e",
  // CI runs the compiled app (below), and `next start` forces
  // NODE_ENV=production — where dev auth deliberately fails closed
  // (lib/env.ts). This is the explicit, visible override that rule
  // provides, scoped to the throwaway e2e runtime.
  ALLOW_DEV_AUTH_IN_PROD: "1",
};

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  // The whole run must die loudly long before the CI job timeout: the
  // hosted-runner hang (backlog #18) produced thirty silent minutes and an
  // unusable "cancelled". line streams per-test output as it happens.
  globalTimeout: 12 * 60_000,
  reporter: process.env.CI ? [["line"], ["github"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    // CI compiles once and serves — `next dev` recompiles every route on
    // first visit, which blew the 20-minute job timeout on a 2-core
    // runner. Locally dev stays: instant feedback beats build time there.
    command: process.env.CI
      ? `npx next build && npx next start -p ${PORT}`
      : `npx next dev -p ${PORT}`,
    port: PORT,
    env,
    reuseExistingServer: false,
    timeout: 420_000,
  },
});
