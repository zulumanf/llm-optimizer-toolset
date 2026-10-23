import { describe, expect, it } from "vitest";

describe("error forwarding dedupe (spec 151 D2)", () => {
  it("forwards an event once per window", async () => {
    const { shouldForward, ERROR_FORWARD_WINDOW_MS } = await import("@/lib/logger");
    const seen = new Map<string, number>();
    expect(shouldForward("x", 0, seen)).toBe(true);
    expect(shouldForward("x", 1000, seen)).toBe(false);
    expect(shouldForward("y", 1000, seen)).toBe(true);
    expect(shouldForward("x", ERROR_FORWARD_WINDOW_MS + 1, seen)).toBe(true);
  });
});

describe("forwarded error lines carry no personal contact data", () => {
  it("redacts emails and phone numbers", async () => {
    const { redactForwarded } = await import("@/lib/logger");
    expect(redactForwarded('{"to":"jane.doe@realagency.com","phone":"(555) 123-4567"}')).toBe('{"to":"[email]","phone":"[phone]"}');
  });
});
