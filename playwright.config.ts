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
};

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    port: PORT,
    env,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
