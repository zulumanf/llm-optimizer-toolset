import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    environment: "node",
    setupFiles: ["tests/setup.ts"],
    // One suite per test database: an advisory lock refuses a second
    // concurrent vitest invocation instead of letting the two drop each
    // other's schema mid-flight (B4).
    globalSetup: ["tests/global-setup.ts"],
    // Integration files share one test database and reset its schema
    fileParallelism: false,
  },
});
