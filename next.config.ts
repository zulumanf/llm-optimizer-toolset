import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Container builds (spec 059): a self-contained server bundle.
  output: "standalone",
  // A stray lockfile in the home dir otherwise makes Next mis-infer the root
  outputFileTracingRoot: __dirname,
  // E2E runs its own server with its own build dir (.next-e2e) so it can
  // never clobber a live dev server's chunks — the shared-.next trap
  // (run-app skill §1), designed out (spec 049).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Private report surfaces (spec 134): never indexed, never cached by a
  // shared cache, never leaking a credential-bearing URL through a referrer.
  async headers() {
    const privateHeaders = [
      { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
      { key: "Cache-Control", value: "private, no-store" },
      { key: "Referrer-Policy", value: "no-referrer" },
    ];
    return [
      { source: "/report/:path*", headers: privateHeaders },
      { source: "/audit/:path*", headers: privateHeaders },
    ];
  },
};

export default nextConfig;
