/**
 * Auth redirects must be built from APP_URL, not the request's own origin.
 * Behind Railway's proxy the request origin resolves to the container's
 * internal hostname (e.g. https://98d71eb6ee29:8080), which sent every
 * magic-link landing and login redirect to an unreachable address.
 */
import { describe, expect, it } from "vitest";
import { publicOrigin } from "@/lib/env";

describe("publicOrigin", () => {
  it("prefers APP_URL over the request-derived origin", () => {
    expect(
      publicOrigin("https://98d71eb6ee29:8080", "https://app.recommendedfirst.com")
    ).toBe("https://app.recommendedfirst.com");
  });

  it("falls back to the request origin when APP_URL is unset (dev)", () => {
    expect(publicOrigin("http://localhost:3000", undefined)).toBe(
      "http://localhost:3000"
    );
  });

  it("resolves redirect paths against the public origin", () => {
    const base = publicOrigin(
      "https://98d71eb6ee29:8080",
      "https://app.recommendedfirst.com"
    );
    expect(new URL("/login?error=callback", base).toString()).toBe(
      "https://app.recommendedfirst.com/login?error=callback"
    );
  });
});
