/**
 * Marketing routing helpers (spec 061): the apex-host rewrite and the
 * chrome/public path check are pure functions so middleware behavior is
 * testable without a request object.
 */
import { describe, expect, it } from "vitest";
import {
  isMarketingPath,
  marketingRewriteTarget,
} from "@/lib/marketing/constants";

describe("isMarketingPath", () => {
  it("matches marketing prefixes and their children", () => {
    expect(isMarketingPath("/home")).toBe(true);
    expect(isMarketingPath("/methodology")).toBe(true);
    expect(isMarketingPath("/sample-audit")).toBe(true);
    expect(isMarketingPath("/home/anything")).toBe(true);
  });

  it("does not match the workspace, near-miss prefixes, or the root", () => {
    expect(isMarketingPath("/")).toBe(false);
    expect(isMarketingPath("/projects")).toBe(false);
    expect(isMarketingPath("/homework")).toBe(false);
    expect(isMarketingPath("/audit/token")).toBe(false);
  });
});

describe("marketingRewriteTarget", () => {
  const hosts = "recommendedfirst.com,www.recommendedfirst.com";

  it("rewrites / to /home on a configured marketing host", () => {
    expect(marketingRewriteTarget("recommendedfirst.com", "/", hosts)).toBe("/home");
    expect(marketingRewriteTarget("www.recommendedfirst.com", "/", hosts)).toBe("/home");
  });

  it("ignores ports and case in the host header", () => {
    expect(marketingRewriteTarget("Recommendedfirst.com:443", "/", hosts)).toBe("/home");
  });

  it("leaves the app host, other paths, and unconfigured deploys alone", () => {
    expect(marketingRewriteTarget("app.recommendedfirst.com", "/", hosts)).toBeNull();
    expect(marketingRewriteTarget("recommendedfirst.com", "/projects", hosts)).toBeNull();
    expect(marketingRewriteTarget("recommendedfirst.com", "/", undefined)).toBeNull();
    expect(marketingRewriteTarget(null, "/", hosts)).toBeNull();
  });
});
