/**
 * Spec 147 slice 1 — the confirmed-profile-URL selection (pure) and the
 * inference-bound configuration.
 */
import { describe, expect, it } from "vitest";
import {
  normalizeProfileUrl,
  selectConfirmedProfileUrls,
} from "@/lib/profile-corrections/urls";
import { profileCheckMaxInferenceRuns } from "@/lib/profile-corrections/config";
import {
  PROFILE_CHECK_DEFAULT_MAX_INFERENCE_RUNS,
  PROFILE_CHECK_IDEMPOTENCY_TEMPLATE,
  PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
  profileCheckIdempotencyKey,
  profileCheckRunKey,
} from "@/lib/profile-corrections/constants";
import { profileCheckWindow } from "@/lib/profile-corrections/start";
import { renderIdempotencyKey } from "@/lib/events/filter";
import { eventDefinition } from "@/lib/events/catalog";

const row = (id: string, sourceRef: string | null) => ({ id, sourceRef, createdAt: new Date(0) });

describe("normalizeProfileUrl", () => {
  it("accepts absolute http(s) URLs in canonical form", () => {
    expect(normalizeProfileUrl(" https://WWW.Zillow.com/profile/ana ")).toBe("https://www.zillow.com/profile/ana");
    expect(normalizeProfileUrl("http://perezrealty.example")).toBe("http://perezrealty.example/");
  });

  it.each([
    "ftp://files.example/profile",
    "mailto:ana@example.com",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "/relative/path",
    "zillow.com/profile/ana",
    "https://user:secret@example.com/profile",
    "",
  ])("rejects %s", (raw) => {
    expect(normalizeProfileUrl(raw)).toBeNull();
  });
});

describe("selectConfirmedProfileUrls", () => {
  it("keeps the first row per normalized URL and reports every skip", () => {
    const result = selectConfirmedProfileUrls([
      row("a", "https://www.zillow.com/profile/ana"),
      row("b", "https://WWW.ZILLOW.COM/profile/ana"),
      row("c", "not a url"),
      row("d", null),
      row("e", "   "),
      row("f", "https://perezrealty.example/"),
    ]);
    expect(result.urls).toEqual([
      { contextItemId: "a", profileUrl: "https://www.zillow.com/profile/ana" },
      { contextItemId: "f", profileUrl: "https://perezrealty.example/" },
    ]);
    expect(result.skipped.map((s) => [s.contextItemId, s.reason])).toEqual([
      ["b", "duplicate_url"],
      ["c", "invalid_url"],
      ["d", "no_url"],
      ["e", "no_url"],
    ]);
  });

  it("caps at 25 and reports the overflow, deterministically", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(`r${i}`, `https://d.example/${i}`));
    const result = selectConfirmedProfileUrls(rows);
    expect(PROFILE_CHECK_MAX_PROFILES_PER_PROJECT).toBe(25);
    expect(result.urls.map((u) => u.contextItemId)).toEqual(rows.slice(0, 25).map((r) => r.id));
    expect(result.skipped.map((s) => [s.contextItemId, s.reason])).toEqual(
      rows.slice(25).map((r) => [r.id, "over_cap"])
    );
    expect(selectConfirmedProfileUrls(rows)).toEqual(result);
  });

  it("returns nothing for no rows", () => {
    expect(selectConfirmedProfileUrls([])).toEqual({ urls: [], skipped: [] });
  });
});

describe("profileCheckMaxInferenceRuns", () => {
  it("defaults to 1", () => {
    expect(PROFILE_CHECK_DEFAULT_MAX_INFERENCE_RUNS).toBe(1);
    expect(profileCheckMaxInferenceRuns({})).toBe(1);
    expect(profileCheckMaxInferenceRuns({ PROFILE_CHECK_MAX_INFERENCE_RUNS: " " })).toBe(1);
  });

  it("accepts 1 to 25", () => {
    expect(profileCheckMaxInferenceRuns({ PROFILE_CHECK_MAX_INFERENCE_RUNS: "1" })).toBe(1);
    expect(profileCheckMaxInferenceRuns({ PROFILE_CHECK_MAX_INFERENCE_RUNS: "25" })).toBe(25);
  });

  it.each(["0", "26", "-1", "1.5", "two", "1e1"])("refuses %s rather than guessing", (value) => {
    expect(() => profileCheckMaxInferenceRuns({ PROFILE_CHECK_MAX_INFERENCE_RUNS: value })).toThrow(
      /must be an integer from 1 to 25/
    );
  });
});

describe("check identity and windows", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const checkRequestId = "22222222-2222-4222-8222-222222222222";

  it("stores exactly the key the engine will give the run", () => {
    const rendered = renderIdempotencyKey(PROFILE_CHECK_IDEMPOTENCY_TEMPLATE, {
      id: "evt-1",
      type: "profile.check_requested",
      projectId,
      payload: { checkRequestId },
    });
    expect(rendered).toBe(profileCheckIdempotencyKey(projectId, checkRequestId));
    expect(profileCheckRunKey(projectId, checkRequestId)).toBe(`live:${rendered}`);
  });

  it("validates the event payload: uuids and http(s) only", () => {
    const schema = eventDefinition("profile.check_requested")!.schema;
    const payload = {
      checkRequestId,
      contextItemId: projectId,
      profileUrl: "https://www.zillow.com/profile/ana",
      origin: "schedule",
      window: "week:2026-10-05",
    };
    expect(schema.safeParse(payload).success).toBe(true);
    expect(schema.safeParse({ ...payload, profileUrl: "ftp://x.example/" }).success).toBe(false);
    expect(schema.safeParse({ ...payload, checkRequestId: "nope" }).success).toBe(false);
    expect(schema.safeParse({ ...payload, origin: "recheck" }).success).toBe(false);
    expect(eventDefinition("profile.check_requested")!.requiresProject).toBe(true);
  });

  it("separates the weekly and operator windows", () => {
    const monday = new Date("2026-10-05T12:00:00Z");
    const thursday = new Date("2026-10-08T12:00:00Z");
    expect(profileCheckWindow("schedule", monday)).toBe("week:2026-10-05");
    expect(profileCheckWindow("schedule", thursday)).toBe("week:2026-10-05");
    expect(profileCheckWindow("operator", monday)).toBe("day:2026-10-05");
    expect(profileCheckWindow("operator", thursday)).toBe("day:2026-10-08");
  });
});
