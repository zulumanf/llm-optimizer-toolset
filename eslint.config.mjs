// Flat ESLint config (cleanup 2026-08-18). `next lint` is removed in Next
// 16; eslint-config-next@15 still ships legacy configs, so FlatCompat
// bridges them until the Next 16 upgrade replaces this with direct imports.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const config = [
  {
    ignores: [
      ".next/**",
      ".next-e2e/**",
      ".claude/**",
      "node_modules/**",
      "next-env.d.ts",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // docs/11: no `any`, ever — an error, not a warning.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];

export default config;
