/**
 * Unit tests for the trigger system's pure logic: cron parsing, timezone and
 * DST behaviour, fire-key identity, missed-run policies, threshold transitions,
 * and webhook signature verification.
 *
 * These are the properties that decide *when the platform acts*, so they are
 * tested without a database — a scheduling bug that only shows up in production
 * at 2am on the second Sunday in November is not one you want to find there.
 */
import { describe, expect, it } from "vitest";
import {
  fireKeyForSlot,
  nextOccurrence,
  occurrencesBetween,
  parseCron,
  utcFromZoned,
  zonedParts,
} from "@/lib/triggers/cron";
import { plannedSlots, MAX_CATCHUP_DAYS } from "@/lib/triggers/service";
import { compare, decideThreshold, knownMetricKeys } from "@/lib/triggers/threshold";
import { verifySignature, SIGNATURE_WINDOW_SECONDS } from "@/lib/triggers/webhook";
import { createHmac } from "node:crypto";
import { ClassifiedError } from "@/lib/errors";

describe("cron parsing", () => {
  it("parses the five standard fields", () => {
    const fields = parseCron("0 9 * * 1");
    expect(fields.minutes).toEqual([0]);
    expect(fields.hours).toEqual([9]);
    expect(fields.daysOfWeek).toEqual([1]);
    expect(fields.months).toHaveLength(12);
    expect(fields.daysOfMonth).toHaveLength(31);
  });

  it("expands ranges, lists and steps", () => {
    expect(parseCron("0,30 9-11 * * *").minutes).toEqual([0, 30]);
    expect(parseCron("0,30 9-11 * * *").hours).toEqual([9, 10, 11]);
    expect(parseCron("*/15 * * * *").minutes).toEqual([0, 15, 30, 45]);
    expect(parseCron("0 0-23/6 * * *").hours).toEqual([0, 6, 12, 18]);
  });

  it("rejects the wrong number of fields", () => {
    expect(() => parseCron("0 9 * *")).toThrow(ClassifiedError);
    expect(() => parseCron("0 9 * * * *")).toThrow(ClassifiedError);
  });

  it("rejects unsupported syntax rather than mis-scheduling it", () => {
    // A schedule that silently means something else is worse than one that
    // refuses to be created.
    expect(() => parseCron("0 9 L * *")).toThrow(/Unsupported cron syntax/);
    expect(() => parseCron("0 9 * * 5#3")).toThrow(/Unsupported cron syntax/);
    expect(() => parseCron("0 9 15W * *")).toThrow(/Unsupported cron syntax/);
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCron("60 9 * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 24 * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 9 * 13 *")).toThrow(/out of range/);
    expect(() => parseCron("0 9 * * 7")).toThrow(/out of range/);
  });

  it("sets dayOr only when both day fields are restricted", () => {
    expect(parseCron("0 9 * * 1").dayOr).toBe(false);
    expect(parseCron("0 9 15 * *").dayOr).toBe(false);
    expect(parseCron("0 9 15 * 1").dayOr).toBe(true);
  });
});

describe("next occurrence with timezones", () => {
  it("finds the next daily slot in UTC", () => {
    const fields = parseCron("0 9 * * *");
    const next = nextOccurrence(fields, new Date("2026-08-03T08:00:00Z"), "UTC");
    expect(next?.toISOString()).toBe("2026-08-03T09:00:00.000Z");
  });

  it("does not return a slot equal to or before the cursor", () => {
    const fields = parseCron("0 9 * * *");
    const next = nextOccurrence(fields, new Date("2026-08-03T09:00:00Z"), "UTC");
    expect(next?.toISOString()).toBe("2026-08-04T09:00:00.000Z");
  });

  it("keeps a 09:00 New York schedule at 09:00 local across the DST boundary", () => {
    const fields = parseCron("0 9 * * *");
    // November 1 2026 is the US fall-back date. Before it, EDT (UTC-4); after,
    // EST (UTC-5). A naive UTC schedule would drift by an hour.
    const beforeFallBack = nextOccurrence(fields, new Date("2026-10-30T00:00:00Z"), "America/New_York");
    const afterFallBack = nextOccurrence(fields, new Date("2026-11-03T00:00:00Z"), "America/New_York");

    expect(zonedParts(beforeFallBack!, "America/New_York").hour).toBe(9);
    expect(zonedParts(afterFallBack!, "America/New_York").hour).toBe(9);
    // The UTC instants differ by an hour, which is the whole point.
    expect(beforeFallBack!.toISOString()).toContain("13:00:00");
    expect(afterFallBack!.toISOString()).toContain("14:00:00");
  });

  it("keeps local time across the spring-forward boundary too", () => {
    const fields = parseCron("0 9 * * *");
    // March 8 2026 is the US spring-forward date.
    const before = nextOccurrence(fields, new Date("2026-03-05T00:00:00Z"), "America/New_York");
    const after = nextOccurrence(fields, new Date("2026-03-10T00:00:00Z"), "America/New_York");
    expect(zonedParts(before!, "America/New_York").hour).toBe(9);
    expect(zonedParts(after!, "America/New_York").hour).toBe(9);
    expect(before!.toISOString()).toContain("14:00:00");
    expect(after!.toISOString()).toContain("13:00:00");
  });

  it("honours a non-US timezone", () => {
    const fields = parseCron("30 8 * * *");
    // Tokyo is UTC+9 year-round, so 2026-08-03T00:00Z is already 09:00 local —
    // past today's 08:30 slot. The next one is tomorrow local, i.e. 23:30Z today.
    const next = nextOccurrence(fields, new Date("2026-08-03T00:00:00Z"), "Asia/Tokyo");
    expect(next?.toISOString()).toBe("2026-08-03T23:30:00.000Z");
    expect(zonedParts(next!, "Asia/Tokyo").hour).toBe(8);
    expect(zonedParts(next!, "Asia/Tokyo").minute).toBe(30);
    expect(zonedParts(next!, "Asia/Tokyo").day).toBe(4);
  });

  it("rejects an unknown timezone", () => {
    expect(() => nextOccurrence(parseCron("0 9 * * *"), new Date(), "Mars/Olympus")).toThrow(
      /Unknown timezone/
    );
  });

  it("returns null for an expression that can never fire", () => {
    // February 30th does not exist.
    expect(nextOccurrence(parseCron("0 0 30 2 *"), new Date("2026-01-01T00:00:00Z"), "UTC")).toBeNull();
  });

  it("handles monthly and weekday-restricted schedules", () => {
    const monthly = nextOccurrence(parseCron("0 8 3 * *"), new Date("2026-08-05T00:00:00Z"), "UTC");
    expect(monthly?.toISOString()).toBe("2026-09-03T08:00:00.000Z");

    // 2026-08-03 is a Monday.
    const weekday = nextOccurrence(parseCron("0 7 * * 1"), new Date("2026-08-01T00:00:00Z"), "UTC");
    expect(weekday?.toISOString()).toBe("2026-08-03T07:00:00.000Z");
  });

  it("round-trips a wall-clock time through utcFromZoned", () => {
    const utc = utcFromZoned(
      { year: 2026, month: 7, day: 4, hour: 14, minute: 30 },
      "America/Los_Angeles"
    );
    const parts = zonedParts(utc, "America/Los_Angeles");
    expect(parts.hour).toBe(14);
    expect(parts.minute).toBe(30);
    expect(parts.day).toBe(4);
  });
});

describe("occurrencesBetween", () => {
  it("enumerates every missed window in order", () => {
    const slots = occurrencesBetween(
      parseCron("0 * * * *"),
      new Date("2026-08-03T00:00:00Z"),
      new Date("2026-08-03T05:00:00Z"),
      "UTC"
    );
    expect(slots).toHaveLength(5);
    expect(slots[0]!.toISOString()).toBe("2026-08-03T01:00:00.000Z");
    expect(slots[4]!.toISOString()).toBe("2026-08-03T05:00:00.000Z");
  });

  it("respects the limit", () => {
    const slots = occurrencesBetween(
      parseCron("* * * * *"),
      new Date("2026-08-03T00:00:00Z"),
      new Date("2026-08-04T00:00:00Z"),
      "UTC",
      10
    );
    expect(slots).toHaveLength(10);
  });
});

describe("fire keys", () => {
  it("identifies the window, not the moment of firing", () => {
    const slot = new Date("2026-08-03T09:00:00.000Z");
    // Two dispatchers computing the same slot must produce the same key, which
    // is what makes the unique index collapse them to one run.
    expect(fireKeyForSlot(slot)).toBe("2026-08-03T09:00:00Z");
    expect(fireKeyForSlot(new Date("2026-08-03T09:00:00.999Z"))).toBe("2026-08-03T09:00:00Z");
  });
});

describe("missed-run policies", () => {
  const base = {
    cron: "0 * * * *",
    timezone: "UTC",
    startsAt: null,
    now: new Date("2026-08-03T05:30:00Z"),
  };

  it("run_all fires every missed window", () => {
    const { toFire, toSkip } = plannedSlots({
      ...base,
      lastFiredAt: new Date("2026-08-03T00:30:00Z"),
      policy: "run_all",
    });
    expect(toFire).toHaveLength(5);
    expect(toSkip).toHaveLength(0);
  });

  it("run_once fires the newest and records the rest as skipped", () => {
    const { toFire, toSkip } = plannedSlots({
      ...base,
      lastFiredAt: new Date("2026-08-03T00:30:00Z"),
      policy: "run_once",
    });
    expect(toFire).toHaveLength(1);
    expect(toFire[0]!.toISOString()).toBe("2026-08-03T05:00:00.000Z");
    // The gap is visible rather than silent.
    expect(toSkip).toHaveLength(4);
  });

  it("skip fires only the newest and marks the others skipped", () => {
    const { toFire, toSkip } = plannedSlots({
      ...base,
      lastFiredAt: new Date("2026-08-03T00:30:00Z"),
      policy: "skip",
    });
    expect(toFire).toHaveLength(1);
    expect(toSkip).toHaveLength(4);
  });

  it("fires nothing when no window has elapsed", () => {
    const { toFire, toSkip } = plannedSlots({
      ...base,
      lastFiredAt: new Date("2026-08-03T05:00:00Z"),
      policy: "run_once",
    });
    expect(toFire).toHaveLength(0);
    expect(toSkip).toHaveLength(0);
  });

  it("bounds catch-up so a long outage does not fire a month of reports", () => {
    const { toFire } = plannedSlots({
      cron: "0 9 * * *",
      timezone: "UTC",
      startsAt: null,
      lastFiredAt: new Date("2025-01-01T00:00:00Z"),
      now: new Date("2026-08-03T12:00:00Z"),
      policy: "run_all",
    });
    // Bounded by MAX_CATCHUP_DAYS, not by how long we were away.
    expect(toFire.length).toBeLessThanOrEqual(MAX_CATCHUP_DAYS + 1);
  });
});

describe("threshold comparison", () => {
  it("compares in every supported direction", () => {
    expect(compare(5, "gt", 3)).toBe(true);
    expect(compare(3, "gt", 3)).toBe(false);
    expect(compare(3, "gte", 3)).toBe(true);
    expect(compare(2, "lt", 3)).toBe(true);
    expect(compare(3, "lte", 3)).toBe(true);
  });

  it("declares its metric catalogue", () => {
    const keys = knownMetricKeys();
    expect(keys).toContain("recommendation_rate");
    expect(keys).toContain("claims_expiring_soon");
    expect(keys).toContain("overdue_approvals");
    expect(keys.length).toBeGreaterThan(3);
  });
});

describe("threshold transitions", () => {
  const sample = { value: 0.2, sampleSize: 100, detail: {} };

  it("fires on the crossing", () => {
    const verdict = decideThreshold({
      sample,
      comparison: "lt",
      thresholdValue: 0.3,
      minimumSample: 20,
      previouslyBreached: false,
    });
    expect(verdict.outcome).toBe("fire");
    expect(verdict.breached).toBe(true);
  });

  it("does not re-fire while the metric stays past the line", () => {
    const verdict = decideThreshold({
      sample,
      comparison: "lt",
      thresholdValue: 0.3,
      minimumSample: 20,
      previouslyBreached: true,
    });
    expect(verdict.outcome).toBe("no_change");
  });

  it("re-arms when the metric crosses back", () => {
    const verdict = decideThreshold({
      sample: { value: 0.5, sampleSize: 100, detail: {} },
      comparison: "lt",
      thresholdValue: 0.3,
      minimumSample: 20,
      previouslyBreached: true,
    });
    expect(verdict.outcome).toBe("rearmed");
    expect(verdict.breached).toBe(false);
  });

  it("refuses to fire below the minimum sample", () => {
    const verdict = decideThreshold({
      sample: { value: 0.1, sampleSize: 4, detail: {} },
      comparison: "lt",
      thresholdValue: 0.3,
      minimumSample: 20,
      previouslyBreached: false,
    });
    // An alert computed from four observations is noise wearing an alert's clothes.
    expect(verdict.outcome).toBe("insufficient_sample");
  });

  it("treats a missing sample as insufficient, never as a breach", () => {
    const verdict = decideThreshold({
      sample: null,
      comparison: "lt",
      thresholdValue: 0.3,
      minimumSample: 1,
      previouslyBreached: false,
    });
    expect(verdict.outcome).toBe("insufficient_sample");
  });
});

describe("webhook signature verification", () => {
  const secret = "whsec_test_secret_value";
  const body = '{"event":"lead.created","id":"abc"}';

  it("accepts a correct HMAC-SHA256 signature", () => {
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const verdict = verifySignature({
      scheme: "hmac_sha256",
      secret,
      rawBody: body,
      signature,
      timestamp: null,
    });
    expect(verdict.valid).toBe(true);
  });

  it("rejects a wrong signature", () => {
    const verdict = verifySignature({
      scheme: "hmac_sha256",
      secret,
      rawBody: body,
      signature: "deadbeef".repeat(8),
      timestamp: null,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("mismatch");
  });

  it("rejects a signature computed over a different body", () => {
    const signature = createHmac("sha256", secret).update('{"tampered":true}').digest("hex");
    const verdict = verifySignature({
      scheme: "hmac_sha256",
      secret,
      rawBody: body,
      signature,
      timestamp: null,
    });
    expect(verdict.valid).toBe(false);
  });

  it("rejects when no secret is configured", () => {
    const verdict = verifySignature({
      scheme: "hmac_sha256",
      secret: null,
      rawBody: body,
      signature: "anything",
      timestamp: null,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("no signing secret");
  });

  it("rejects a missing signature header", () => {
    const verdict = verifySignature({
      scheme: "hmac_sha256",
      secret,
      rawBody: body,
      signature: null,
      timestamp: null,
    });
    expect(verdict.valid).toBe(false);
  });

  it("verifies a Stripe-style timestamp-prefixed signature", () => {
    const now = new Date("2026-08-03T12:00:00Z");
    const timestamp = Math.floor(now.getTime() / 1000);
    const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
    const verdict = verifySignature({
      scheme: "stripe",
      secret,
      rawBody: body,
      signature,
      timestamp,
      now,
    });
    expect(verdict.valid).toBe(true);
  });

  it("rejects a replayed signature outside the timestamp window", () => {
    const now = new Date("2026-08-03T12:00:00Z");
    const stale = Math.floor(now.getTime() / 1000) - (SIGNATURE_WINDOW_SECONDS + 60);
    const signature = createHmac("sha256", secret).update(`${stale}.${body}`).digest("hex");
    const verdict = verifySignature({
      scheme: "stripe",
      secret,
      rawBody: body,
      // The signature itself is valid — the age is what disqualifies it.
      signature,
      timestamp: stale,
      now,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("window");
  });

  it("requires a timestamp for the Stripe scheme", () => {
    const verdict = verifySignature({
      scheme: "stripe",
      secret,
      rawBody: body,
      signature: "abc",
      timestamp: null,
    });
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("requires a signed timestamp");
  });

  it("honours a timestamp on the plain HMAC scheme when one is present", () => {
    const now = new Date("2026-08-03T12:00:00Z");
    const stale = Math.floor(now.getTime() / 1000) - 3600;
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const verdict = verifySignature({
      scheme: "hmac_sha256",
      secret,
      rawBody: body,
      signature,
      timestamp: stale,
      now,
    });
    // A valid signature over a very old body is still a replay.
    expect(verdict.valid).toBe(false);
  });

  it("passes through when the scheme is explicitly none", () => {
    const verdict = verifySignature({
      scheme: "none",
      secret: null,
      rawBody: body,
      signature: null,
      timestamp: null,
    });
    expect(verdict.valid).toBe(true);
  });
});
