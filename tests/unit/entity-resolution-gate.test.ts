import { describe, expect, it } from "vitest";
import {
  classifyEntityResolution,
  ENTITY_RESOLUTION_UNVERIFIED,
  type LeadAgentRelationship,
} from "@/lib/prospects/entity-aliases";
import { parkedRefusalDisposition } from "@/lib/prospects/followups";

const rel = (o: Partial<LeadAgentRelationship>): LeadAgentRelationship => ({
  companyId: "c1", companyName: "Blu House Properties", existingAliases: [], entityType: "team", teamLead: "Ryan John Ogle",
  realtrendsRecordId: "rt1", productionYear: 2025, contactName: null, contactId: null, ...o,
});
const base = { companyId: "c1", companyName: "Blu House Properties", operatorVerified: null } as const;

describe("entity resolution gate — every count-stating email needs a fully verified entity (2026-09-07)", () => {
  it("TEAM: derived lead aliases must already be on the company", () => {
    const missing = classifyEntityResolution({ ...base, prospectType: "team", rel: rel({}) });
    expect(missing.verified).toBe(false);
    expect(missing.reason).toMatch(/not applied.*Ryan John Ogle/);
    const applied = classifyEntityResolution({ ...base, prospectType: "team", rel: rel({ existingAliases: ["Ryan John Ogle", "Ryan Ogle"] }) });
    expect(applied).toMatchObject({ verified: true, level: "team" });
  });
  it("TEAM: a single-name lead is review, never a guess; no lead is unverified", () => {
    expect(classifyEntityResolution({ ...base, prospectType: "team", rel: rel({ teamLead: "Mike" }) })).toMatchObject({ verified: false, level: "team" });
    expect(classifyEntityResolution({ ...base, prospectType: "team", rel: rel({ teamLead: null }) }).verified).toBe(false);
  });
  it("TEAM: lead covered by the company name counts as verified", () => {
    const s = classifyEntityResolution({ ...base, companyName: "Ryan Ogle", prospectType: "team", rel: rel({ companyName: "Ryan Ogle", teamLead: "Ryan Ogle" }) });
    expect(s.verified).toBe(true);
  });
  it("INDIVIDUAL: canonical person from the licensed record; non-person names fail", () => {
    expect(classifyEntityResolution({ ...base, prospectType: "individual_agent", rel: rel({ companyName: "Daniel Egan", entityType: "individual", teamLead: null }) })).toMatchObject({ verified: true, level: "individual" });
    expect(classifyEntityResolution({ ...base, prospectType: "individual_agent", rel: rel({ companyName: "Egan", entityType: "individual", teamLead: null }) }).verified).toBe(false);
  });
  it("level mismatch between prospect row and licensed record is unverified, not reconciled", () => {
    expect(classifyEntityResolution({ ...base, prospectType: "team", rel: rel({ entityType: "individual" }) }).reason).toMatch(/recorded as a team/);
    expect(classifyEntityResolution({ ...base, prospectType: "individual_agent", rel: rel({}) }).reason).toMatch(/recorded as an individual/);
  });
  it("BROKERAGE/OFFICE: only an operator verification record passes; no record at all fails closed", () => {
    expect(classifyEntityResolution({ ...base, prospectType: "brokerage", rel: rel({}) }).verified).toBe(false);
    expect(classifyEntityResolution({ ...base, prospectType: "brokerage", rel: null, operatorVerified: { level: "brokerage", sourceUrl: "https://x.example/office", at: new Date() } })).toMatchObject({ verified: true, level: "brokerage" });
    expect(classifyEntityResolution({ ...base, prospectType: null, rel: rel({ realtrendsRecordId: null, entityType: null }) }).reason).toMatch(/no authoritative identity record/);
  });
  it("the refusal code is the stable gate string", () => {
    expect(ENTITY_RESOLUTION_UNVERIFIED).toBe("ENTITY_RESOLUTION_UNVERIFIED");
  });
});

describe("refused follow-up disposition — operational refusals re-plan, human ones hold", () => {
  it("mailbox and brokerage caps re-plan (Julie Lane, 2026-09-04)", () => {
    expect(parkedRefusalDisposition("Send refused: Janet McAfee Inc. already received 3 sends in this market in 30 days — the cap is 3.")).toBe("replan");
    expect(parkedRefusalDisposition("The daily Gmail cap of 25 sends is spent — the send refuses until the 24-hour window clears.")).toBe("replan");
  });
  it("reply, DNC, correction, entity uncertainty, evidence failure, exclusivity hold", () => {
    for (const r of [
      "ENTITY_RESOLUTION_UNVERIFIED: Pink Team — team lead \"Monica\" is a single name",
      "This prospect has a recorded reply; no transmit after a conversation started.",
      "Contact is do-not-contact (hard_bounce).",
      "Spec 130 evidence correction 1aa815da: frozen counts 0/17 superseded by 31/17.",
      "A reserved territory blocks this send.",
      "[stale_benchmark] the benchmark is older than 14 days",
      "something nobody has seen before",
    ]) expect(parkedRefusalDisposition(r), r).toBe("hold");
  });
});
