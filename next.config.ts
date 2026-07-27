import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A stray lockfile in the home dir otherwise makes Next mis-infer the root
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
