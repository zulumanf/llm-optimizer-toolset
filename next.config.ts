import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray lockfile in the home dir otherwise makes Next mis-infer the root
  outputFileTracingRoot: __dirname,
  // E2E runs its own server with its own build dir (.next-e2e) so it can
  // never clobber a live dev server's chunks — the shared-.next trap
  // (run-app skill §1), designed out (spec 049).
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
