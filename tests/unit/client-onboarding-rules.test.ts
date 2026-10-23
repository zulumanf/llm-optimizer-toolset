import { describe, expect, it } from "vitest";
import {
  EMPTY_CONTACTS,
  changedFields,
  defaultPrimaryFocus,
  marketDiffers,
  missingContactFields,
  onboardingContextItems,
  onboardingStep,
  parseUsdInput,
  preparedMissing,
  prioritiesSchema,
  validateFinalContacts,
} from "@/lib/engagements/client-onboarding-rules";
import { focusFromWork, questionReviewTodo } from "@/lib/portal/client-copy";
import { segmentOf } from "@/lib/engagements/question-review";

const P = { primaryFocus: "sellers" as const, minPropertyValueUsd: 300_000, additionalOpportunity: "Luxury listings", market: "Albuquerque area" };

describe("client onboarding rules (spec 155)", () => {
  it("derives the step from timestamps, never from views", () => {
    expect(onboardingStep({ status: "ready", prioritiesConfirmedAt: null })).toBe("priorities");
    expect(onboardingStep({ status: "ready", prioritiesConfirmedAt: new Date() })).toBe("contacts");
    expect(onboardingStep({ status: "completed", prioritiesConfirmedAt: new Date() })).toBe("done");
  });

  it("asks only for what is missing", () => {
    expect(missingContactFields({ ...EMPTY_CONTACTS, primaryName: "Lucia", primaryEmail: "l@x.test", approverIsPrimary: true })).toEqual([]);
    expect(missingContactFields({ ...EMPTY_CONTACTS, primaryName: "Lucia" })).toEqual(["primaryEmail", "approver"]);
  });

  it("validates final contacts with short plain messages", () => {
    expect(validateFinalContacts({ ...EMPTY_CONTACTS, primaryName: "Lucia", primaryEmail: "l@x.test", approverIsPrimary: true })).toEqual({ ok: true });
    expect(validateFinalContacts({ ...EMPTY_CONTACTS, primaryName: "Lucia", primaryEmail: "nope", approverIsPrimary: true })).toEqual({ ok: false, message: "Enter a valid email address." });
    expect(validateFinalContacts({ ...EMPTY_CONTACTS, primaryName: "Lucia", primaryEmail: "l@x.test" })).toEqual({ ok: false, message: "Tell us who approves public changes." });
  });

  it("parses friendly currency input", () => {
    expect(parseUsdInput("$300,000")).toBe(300_000);
    expect(parseUsdInput("300k")).toBe(300_000);
    expect(parseUsdInput("1.2m")).toBe(1_200_000);
    expect(parseUsdInput("lots")).toBeNull();
    expect(parseUsdInput("0")).toBeNull();
  });

  it("refuses an incomplete draft and invalid priorities", () => {
    expect(preparedMissing({ primaryFocus: null, minPropertyValueUsd: null, additionalOpportunity: "", market: "" })).toEqual(["primary focus", "market"]);
    expect(prioritiesSchema.safeParse({ ...P, minPropertyValueUsd: 12.5 }).success).toBe(false);
    expect(prioritiesSchema.safeParse(P).success).toBe(true);
  });

  it("records client-provenance items; market is a stated priority with a difference flag", () => {
    const items = onboardingContextItems(P, { ...EMPTY_CONTACTS, primaryName: "Lucia", primaryEmail: "l@x.test", approverIsPrimary: true }, "Albuquerque, NM");
    expect(items.map((i) => i.label)).toEqual([
      "Primary focus: Home sellers",
      "Minimum property value: $300,000",
      "Additional opportunity: Luxury listings",
      "Market: Albuquerque area",
      "Primary contact: Lucia",
      "Approver: Lucia",
    ]);
    expect(items.every((i) => i.provenance === "client_confirmed" || i.provenance === "client_priority")).toBe(true);
    expect(items.find((i) => i.kind === "priority_area")!.value.differsFromEngagementMarket).toBe(false);
    expect(marketDiffers("Santa Fe", "Albuquerque, NM")).toBe(true);
  });

  it("reports which fields the client changed", () => {
    expect(changedFields(P, null)).toEqual([]);
    expect(changedFields(P, { ...P, market: "Rio Rancho" })).toEqual(["market"]);
  });

  it("prefills focus from recorded wording only", () => {
    expect(defaultPrimaryFocus(["Segment: Sellers $300K–$499K"])).toBe("sellers");
    expect(defaultPrimaryFocus(["Buyers", "Seller listings"])).toBe("buyers_and_sellers");
    expect(defaultPrimaryFocus(["Northeast Heights"])).toBeNull();
  });

  it("client copy helpers", () => {
    expect(focusFromWork(["A", "B", "C"])).toEqual(["A", "B"]);
    expect(questionReviewTodo(64, 64)).toBe("Review your 64 customer questions");
    expect(questionReviewTodo(10, 64)).toBe("Finish reviewing your customer questions (10 left)");
    expect(segmentOf({ priceTier: null, audience: null })).toBe("Other questions");
  });
});
