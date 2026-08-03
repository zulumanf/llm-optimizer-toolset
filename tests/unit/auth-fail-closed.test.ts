/**
 * Production-readiness plan, phase 0.1: AUTH_MODE must fail closed. The env
 * schema defaults AUTH_MODE to "dev", and dev mode serves a passwordless
 * admin session — so a production process that forgot the variable must
 * refuse to serve rather than expose the whole workspace. The build phase is
 * exempt (next build prerenders under NODE_ENV=production with no traffic),
 * and ALLOW_DEV_AUTH_IN_PROD=1 is the visible override, mirroring
 * ALLOW_MOCK_PROVIDER.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { devAuthRefusalReason } from "@/lib/env";
import { getCurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("devAuthRefusalReason", () => {
  it("allows dev auth outside production", () => {
    expect(devAuthRefusalReason({ NODE_ENV: "test" })).toBeNull();
    expect(devAuthRefusalReason({ NODE_ENV: "development" })).toBeNull();
    expect(devAuthRefusalReason({})).toBeNull();
  });

  it("refuses a production process with AUTH_MODE unset or dev", () => {
    expect(devAuthRefusalReason({ NODE_ENV: "production" })).toMatch(
      /passwordless admin/
    );
    expect(
      devAuthRefusalReason({ NODE_ENV: "production", AUTH_MODE: "dev" })
    ).toMatch(/Refusing to serve/);
  });

  it("never refuses when auth is actually on", () => {
    expect(
      devAuthRefusalReason({ NODE_ENV: "production", AUTH_MODE: "supabase" })
    ).toBeNull();
  });

  it("exempts the next build phase", () => {
    expect(
      devAuthRefusalReason({
        NODE_ENV: "production",
        NEXT_PHASE: "phase-production-build",
      })
    ).toBeNull();
  });

  it("honours the explicit override, and only the exact value", () => {
    expect(
      devAuthRefusalReason({
        NODE_ENV: "production",
        ALLOW_DEV_AUTH_IN_PROD: "1",
      })
    ).toBeNull();
    for (const value of ["0", "false", "", "yes"]) {
      expect(
        devAuthRefusalReason({
          NODE_ENV: "production",
          ALLOW_DEV_AUTH_IN_PROD: value,
        })
      ).not.toBeNull();
    }
  });
});

describe("getCurrentUser under a production process", () => {
  it("throws instead of returning the dev admin", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("ALLOW_DEV_AUTH_IN_PROD", "");
    await expect(getCurrentUser()).rejects.toThrowError(ClassifiedError);
    await expect(getCurrentUser()).rejects.toThrowError(/Refusing to serve/);
  });

  it("still serves the dev admin under the test runner", async () => {
    const user = await getCurrentUser();
    expect(user.role).toBe("admin");
  });
});
