/**
 * Spec 171 (dispatch policy v2, founder directive 2026-09-15): collision is
 * per canonical buying unit, never per brokerage brand.
 */
import { describe, expect, it } from "vitest";
import { DAILY_BRAND_SHARE_MAX, DISPATCH_POLICY_VERSION, dailyBrandCap } from "@/lib/prospects/constants";
import { buyingUnitKeys, localOfficeKeyFor, planDailyBatches, sameBuyingUnit } from "@/lib/prospects/dispatch-policy";

const unit = (o: Partial<Parameters<typeof buyingUnitKeys>[0]> & { prospectId: string }) => ({
  companyId: null, launchId: "L1", leadPersonKey: null, email: null, ...o,
});

describe("dispatch policy v2", () => {
  it("declares its version and the 30% daily brand share (4 of 15)", () => {
    expect(DISPATCH_POLICY_VERSION).toBe("dispatch-policy-v2");
    expect(DAILY_BRAND_SHARE_MAX).toBe(0.3);
    expect(dailyBrandCap(15)).toBe(4);
    expect(dailyBrandCap(1)).toBe(1);
  });

  it("same canonical company, same lead person in a market, or same email is one buying unit", () => {
    expect(sameBuyingUnit(unit({ prospectId: "a", companyId: "c1" }), unit({ prospectId: "b", companyId: "c1" }))).toBe(true);
    expect(sameBuyingUnit(unit({ prospectId: "a", leadPersonKey: "ana rivera" }), unit({ prospectId: "b", leadPersonKey: "ana rivera" }))).toBe(true);
    expect(sameBuyingUnit(unit({ prospectId: "a", email: "Ana@X.com " }), unit({ prospectId: "b", email: "ana@x.com" }))).toBe(true);
  });

  it("the same lead name in another market, or the same brokerage brand, is NOT one unit", () => {
    expect(sameBuyingUnit(unit({ prospectId: "a", leadPersonKey: "ana rivera" }), unit({ prospectId: "b", launchId: "L2", leadPersonKey: "ana rivera" }))).toBe(false);
    // Two independent Coldwell Banker teams: different companies, no shared person or email.
    expect(sameBuyingUnit(unit({ prospectId: "a", companyId: "c1" }), unit({ prospectId: "b", companyId: "c2" }))).toBe(false);
  });

  it("a brand never resolves to a local office without an evidence-backed registry entry", () => {
    expect(localOfficeKeyFor("L1", "coldwell banker realty")).toBeNull();
    expect(localOfficeKeyFor("L1", null)).toBeNull();
    const registry = [{ launchId: "L1", brokerageKey: "coldwell banker realty", officeKey: "downtown", source: "https://example.test/office 2026-10-30" }];
    expect(localOfficeKeyFor("L1", "coldwell banker realty", registry)).toBe("L1|office:downtown");
    expect(localOfficeKeyFor("L2", "coldwell banker realty", registry)).toBeNull();
  });

  it("brand concentration only moves sends to a later day; nothing is dropped while capacity remains", () => {
    const cands = Array.from({ length: 6 }, (_, i) => ({ prospectId: `p${i}`, brandKey: "kw" }));
    const plan = planDailyBatches(cands, [{ day: "d1", capacity: 15 }, { day: "d2", capacity: 15 }], 4);
    expect(plan.assigned.filter((a) => a.day === "d1")).toHaveLength(4);
    expect(plan.assigned.filter((a) => a.day === "d2")).toHaveLength(2);
    expect(plan.unassigned).toEqual([]);
  });
});
