/**
 * Dispatch policy v2 (founder directive 2026-09-15): collision per canonical
 * BUYING UNIT, never per brokerage brand; brand concentration is dispatch
 * order only. Regression cases 1–10 from the throughput directive.
 */
import { describe, expect, it } from "vitest";
import { DAILY_BRAND_SHARE_MAX, DAILY_SEND_QUOTA, DISPATCH_POLICY_VERSION, LOCAL_OFFICE_COLLISION_REGISTRY, dailyBrandCap, type LocalOfficeCollisionEntry } from "@/lib/prospects/constants";
import { LOCAL_OFFICE_SEND_CAP_30D, buyingUnitKeys, localOfficeKeyFor, planDailyBatches, sameBuyingUnit } from "@/lib/prospects/dispatch-policy";
import { cohortBlockers, dedupeBuyingUnits, evaluateCandidate, selectCohort, type T1CandidateFacts } from "@/lib/prospects/t1-cohort";
import { evaluateSpendGate } from "@/lib/runs/spend-guard";

const NOW = new Date("2026-09-15T12:00:00Z");
function facts(id: string, over: Partial<T1CandidateFacts> = {}, dedupe: Partial<T1CandidateFacts["dedupe"]> = {}, outreach: Partial<T1CandidateFacts["outreach"]> = {}): T1CandidateFacts {
  return {
    prospectId: id, companyId: `c-${id}`, name: `Team ${id}`, prospectType: "team", entityLevel: "team",
    market: { launchId: "l-1", name: "Reno, NV", stateCode: "NV", protected: false, founderApproved: true, exclusiveConflict: false, launchStatus: "researching" },
    outreach: { stage: "identified", contacted: false, activeSequence: false, positiveReply: false, engagement: false, declined: false, doNotContact: false, suppressed: false, personRecentlyContacted: false, ...outreach },
    mismatch: { eligible: true, reasonCodes: [] },
    release: { verified: true, reasons: [] },
    pendingCorrection: false,
    contact: { id: `ct-${id}`, name: `Lead ${id}`, role: "team lead", email: `${id}@example.com`, provenance: "publicly_sourced", generic: false, isDecisionMaker: true },
    firstName: "Lead",
    features: { runId: "run-1", competitorCompanyId: "cx", competitorName: "Rival", prospectRecs: 0, competitorRecs: 7, denominator: 256, absoluteGap: 7, recommendationMultiple: null, zeroCase: true, prospectProduction: 50_000_000, competitorProduction: 30_000_000, competitorProductionRatio: 0.6, metricType: "closed_volume", productionYear: 2025, distinctQuestions: { prospect: 0, competitor: 4 }, competitorAiRank: 1, competitorRankUniverse: 20 } as unknown as T1CandidateFacts["features"],
    buyerSignals: [], websiteOnFile: true,
    dedupe: { brokerageKey: "compass", leadPersonKey: null, unitContacted: false, localOfficeKey: null, ...dedupe },
    ...over,
  };
}
const item = (f: T1CandidateFacts) => ({ facts: f, evaluation: evaluateCandidate(f, NOW) });

describe("dispatch policy v2 — buying unit, not brokerage logo", () => {
  it("declares its version and the 30% daily brand share (4 of 15)", () => {
    expect(DISPATCH_POLICY_VERSION).toBe("dispatch-policy-v2");
    expect(DAILY_BRAND_SHARE_MAX).toBe(0.3);
    expect(dailyBrandCap(DAILY_SEND_QUOTA)).toBe(4);
    expect(dailyBrandCap(15)).toBe(4);
    expect(dailyBrandCap(1)).toBe(1);
    expect(LOCAL_OFFICE_SEND_CAP_30D).toBe(1);
  });

  it("1: same TEAM, two recipients — only one cold sequence (dedupe keeps the stronger, the other is DUPLICATE_BUYING_UNIT)", () => {
    const a = facts("a", { companyId: "c-team" });
    const b = facts("b", { companyId: "c-team", contact: { id: "ct-b", name: "Ops Manager", role: "operations", email: "ops@example.com", provenance: "publicly_sourced", generic: false, isDecisionMaker: false } });
    const out = dedupeBuyingUnits([item(a), item(b)]);
    const ready = out.filter((o) => o.evaluation.sendReady);
    expect(ready).toHaveLength(1);
    expect(out.find((o) => !o.evaluation.sendReady)!.evaluation.blockers).toContain("DUPLICATE_BUYING_UNIT");
    // and once one member of the unit has a cold sequence on record, the other is blocked at qualification
    const later = facts("b", { companyId: "c-team" }, { unitContacted: true });
    expect(cohortBlockers(later)).toContain("BUYING_UNIT_ACTIVE_SEQUENCE");
  });

  it("2: same individual — recontact policy blocks the duplicate (person window + email dedupe)", () => {
    const recontact = facts("p", {}, {}, { personRecentlyContacted: true });
    expect(cohortBlockers(recontact)).toContain("PERSON_RECENTLY_CONTACTED");
    const a = facts("a"); const b = facts("b", { contact: { ...facts("b").contact!, email: "A@example.com" } });
    const sel = selectCohort({ items: [item(a), item(b)], priorOfficeSends: new Map() });
    expect(sel.selected).toHaveLength(1);
    expect(sel.deferred.map((d) => d.reason)).toEqual(["DUPLICATE_EMAIL"]);
    expect(sameBuyingUnit({ prospectId: "x", companyId: null, launchId: "l-1", leadPersonKey: null, email: "a@example.com" }, { prospectId: "y", companyId: null, launchId: "l-1", leadPersonKey: null, email: "A@example.com" })).toBe(true);
  });

  it("3: two independent Compass teams in the same market both become dispatchable", () => {
    const sel = selectCohort({ items: [item(facts("a")), item(facts("b"))], priorOfficeSends: new Map() });
    expect(sel.selected.map((s) => s.facts.prospectId).sort()).toEqual(["a", "b"]);
    expect(sel.deferred).toEqual([]);
  });

  it("4: two independent KW teams both become dispatchable, even with three prior KW sends in the market", () => {
    const items = [item(facts("a", {}, { brokerageKey: "keller williams" })), item(facts("b", {}, { brokerageKey: "keller williams" }))];
    const sel = selectCohort({ items, priorOfficeSends: new Map([["l-1|keller williams", 3]]) });
    expect(sel.selected).toHaveLength(2);
  });

  it("5: the same brokerage brand does NOT merge canonical buying units", () => {
    const a = { prospectId: "a", companyId: "c-a", launchId: "l-1", leadPersonKey: "jane doe", email: "jane@a.com" };
    const b = { prospectId: "b", companyId: "c-b", launchId: "l-1", leadPersonKey: "john roe", email: "john@b.com" };
    expect(sameBuyingUnit(a, b)).toBe(false);
    expect(buyingUnitKeys(a).some((k) => /compass|brand|brokerage/.test(k))).toBe(false);
    const out = dedupeBuyingUnits([item(facts("a")), item(facts("b"))]);
    expect(out.every((o) => o.evaluation.sendReady)).toBe(true);
  });

  it("6: a known local office with an explicit registry entry gets the conservative one-per-30-days guard", () => {
    const registry: LocalOfficeCollisionEntry[] = [{ launchId: "l-1", brokerageKey: "compass", officeKey: "midtown", source: "office roster page 2026-09-15" }];
    const key = localOfficeKeyFor("l-1", "compass", registry);
    expect(key).toBe("l-1|office:midtown");
    const items = [item(facts("a", {}, { localOfficeKey: key })), item(facts("b", {}, { localOfficeKey: key }))];
    const sel = selectCohort({ items, priorOfficeSends: new Map() });
    expect(sel.selected).toHaveLength(1);
    expect(sel.deferred.map((d) => d.reason)).toEqual(["LOCAL_OFFICE_COLLISION"]);
    // the deferred prospect is still qualified (send-ready), only its dispatch moved
    expect(items.every((i) => i.evaluation.sendReady)).toBe(true);
  });

  it("7: an unknown entity relation cannot silently merge businesses — no registry entry, no brand inference", () => {
    expect(LOCAL_OFFICE_COLLISION_REGISTRY).toEqual([]);
    expect(localOfficeKeyFor("l-1", "compass")).toBeNull();
    expect(localOfficeKeyFor("l-1", "compass", [{ launchId: "l-2", brokerageKey: "compass", officeKey: "x", source: "s" }])).toBeNull();
    expect(localOfficeKeyFor("l-1", null)).toBeNull();
    // a lead key is only present when provenanced; without it two prospects never collide by name guessing
    const a = { prospectId: "a", companyId: null, launchId: "l-1", leadPersonKey: null, email: null };
    const b = { prospectId: "b", companyId: null, launchId: "l-1", leadPersonKey: null, email: null };
    expect(sameBuyingUnit(a, b)).toBe(false);
  });

  it("8: the daily brokerage-brand concentration guard spreads one brand across days", () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({ prospectId: `p${i}`, brandKey: i < 7 ? "compass" : "exp realty" }));
    const plan = planDailyBatches(candidates, [{ day: "2026-09-16", capacity: 15 }, { day: "2026-09-17", capacity: 15 }], 4);
    const day1 = plan.assigned.filter((a) => a.day === "2026-09-16");
    expect(day1.filter((a) => a.brandKey === "compass")).toHaveLength(4);
    expect(plan.assigned.filter((a) => a.day === "2026-09-17" && a.brandKey === "compass")).toHaveLength(3);
    expect(plan.unassigned).toEqual([]);
    // sends already committed that day count toward the brand share
    const withUsed = planDailyBatches(candidates.slice(0, 2), [{ day: "2026-09-16", capacity: 15, brandUsed: { compass: 4 } }, { day: "2026-09-17", capacity: 15 }], 4);
    expect(withUsed.assigned.every((a) => a.day === "2026-09-17")).toBe(true);
  });

  it("9: brand concentration changes dispatch order only — nothing is dropped, just moved later", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({ prospectId: `p${i}`, brandKey: "compass" }));
    const plan = planDailyBatches(candidates, [{ day: "d1", capacity: 15 }], 4);
    expect(plan.assigned).toHaveLength(4);
    expect(plan.unassigned).toEqual([{ prospectId: "p4", reason: "BRAND_CONCENTRATION" }, { prospectId: "p5", reason: "BRAND_CONCENTRATION" }]);
    const more = planDailyBatches(candidates, [{ day: "d1", capacity: 15 }, { day: "d2", capacity: 15 }], 4);
    expect(more.unassigned).toEqual([]);
  });

  it("10: QUALIFIED_T1 is independent from daily concentration", () => {
    const f = facts("a");
    const q = evaluateCandidate(f, NOW);
    expect(q.sendReady).toBe(true);
    const plan = planDailyBatches([{ prospectId: "a", brandKey: "compass" }], [{ day: "d1", capacity: 15, brandUsed: { compass: 4 } }], 4);
    expect(plan.unassigned).toEqual([{ prospectId: "a", reason: "BRAND_CONCENTRATION" }]);
    expect(evaluateCandidate(f, NOW).sendReady).toBe(true); // qualification never consulted the plan
    expect((cohortBlockers(f) as string[]).some((b) => /BRAND|BROKERAGE/.test(b))).toBe(false);
  });
});

describe("spend gate hierarchy (daily pool → sprint ceiling)", () => {
  it("refuses at the daily pool, then at the sprint ceiling, and allows below both", () => {
    expect(evaluateSpendGate({ last24hUsd: 100, dailyCeilingUsd: 100, sprintUsd: 10, sprintCeilingUsd: 125 }).ok).toBe(false);
    expect(evaluateSpendGate({ last24hUsd: 20, dailyCeilingUsd: 100, sprintUsd: 125, sprintCeilingUsd: 125 }).reason).toMatch(/sprint spend ceiling/);
    expect(evaluateSpendGate({ last24hUsd: 20, dailyCeilingUsd: 100, sprintUsd: 60, sprintCeilingUsd: 125 }).ok).toBe(true);
    // no sprint envelope configured → only the daily pool applies
    expect(evaluateSpendGate({ last24hUsd: 24, dailyCeilingUsd: 25, sprintUsd: null, sprintCeilingUsd: null }).ok).toBe(true);
  });
});
