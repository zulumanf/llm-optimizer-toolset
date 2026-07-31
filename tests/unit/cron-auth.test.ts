/**
 * The shared cron gate (lib/security/cron-auth): fail-closed without a
 * secret, 401 on any mismatch, silent pass on the exact bearer. Four
 * routes ride this one implementation — these are the semantics they all
 * inherit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { requireCronSecret } from "@/lib/security/cron-auth";

const ORIGINAL = process.env.CRON_SECRET;

function request(auth?: string): Request {
  return new Request("http://localhost/api/cron/anything", {
    method: "POST",
    headers: auth ? { authorization: auth } : {},
  });
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe("requireCronSecret", () => {
  it("returns 503 when no secret is configured — never open", async () => {
    delete process.env.CRON_SECRET;
    const denied = requireCronSecret(request("Bearer anything"));
    expect(denied?.status).toBe(503);
  });

  it("returns 401 on a wrong, malformed, or missing bearer", () => {
    process.env.CRON_SECRET = "test-secret";
    expect(requireCronSecret(request("Bearer wrong"))?.status).toBe(401);
    expect(requireCronSecret(request("test-secret"))?.status).toBe(401);
    expect(requireCronSecret(request())?.status).toBe(401);
    // Prefix of the real secret — length mismatch must still deny.
    expect(requireCronSecret(request("Bearer test-secre"))?.status).toBe(401);
  });

  it("returns null (authorized) on the exact bearer", () => {
    process.env.CRON_SECRET = "test-secret";
    expect(requireCronSecret(request("Bearer test-secret"))).toBeNull();
  });
});
