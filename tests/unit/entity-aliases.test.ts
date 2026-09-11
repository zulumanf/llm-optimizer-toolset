/**
 * Spec 130: verified lead-agent aliases are derived only from the licensed
 * RealTrends relationship; agents, teams and brokerages stay distinct.
 */
import { describe, expect, it } from "vitest";
import {
  deriveLeadAgentAliases,
  firstLastName,
  identityFactFor,
  ENTITY_REVIEW_REQUIRED,
  type LeadAgentRelationship,
} from "@/lib/prospects/entity-aliases";
import { scanAliases } from "@/lib/parsing/prepass";

const BLU: LeadAgentRelationship = {
  companyId: "85eba138-983b-4eec-b615-d56cf0c4dfe3",
  companyName: "Blu House Properties",
  existingAliases: [],
  entityType: "team",
  teamLead: "Ryan John Ogle",
  realtrendsRecordId: "02d694fc-5742-48ec-82eb-0add37a4a044",
  productionYear: 2025,
  contactName: "Ryan Ogle",
  contactId: "bff98a98-369f-42ed-adc0-343595009737",
};

describe("firstLastName", () => {
  it("drops middle names, initials and generational suffixes", () => {
    expect(firstLastName("Ryan John Ogle")).toBe("Ryan Ogle");
    expect(firstLastName("James E Dulin II")).toBe("James Dulin");
    expect(firstLastName("Matina F. Caul")).toBe("Matina Caul");
    expect(firstLastName("Josh May")).toBe("Josh May");
  });
  it("is null for a single name", () => {
    expect(firstLastName("Christina")).toBeNull();
    expect(firstLastName("Mark Jr.")).toBeNull();
  });
});

describe("deriveLeadAgentAliases — the Ryan Ogle / Blu House fixture", () => {
  it("credits the team lead's recorded and First Last forms plus the same-family contact", () => {
    const d = deriveLeadAgentAliases(BLU);
    expect(d.status).toBe("aliases");
    if (d.status !== "aliases") return;
    expect(d.aliases).toEqual(["Ryan John Ogle", "Ryan Ogle"]);
    expect(d.provenance.realtrendsRecordId).toBe(BLU.realtrendsRecordId);
    expect(d.provenance.contactId).toBe(BLU.contactId);
  });
  it("adds a nickname contact only when the last name matches the team lead", () => {
    const caul = deriveLeadAgentAliases({ ...BLU, companyName: "Caul Team", teamLead: "Matina F Caul", contactName: "Tina Caul" });
    expect(caul.status === "aliases" && caul.aliases).toEqual(["Matina F Caul", "Matina Caul", "Tina Caul"]);
    const stranger = deriveLeadAgentAliases({ ...BLU, contactName: "Mark Brace" });
    expect(stranger.status === "aliases" && stranger.aliases).toEqual(["Ryan John Ogle", "Ryan Ogle"]);
  });
  it("never aliases an individual agent or an unmatched company (agent ≠ team ≠ brokerage)", () => {
    expect(deriveLeadAgentAliases({ ...BLU, entityType: "individual", companyName: "Josh May", teamLead: "Josh May" }).status).toBe("none");
    expect(deriveLeadAgentAliases({ ...BLU, realtrendsRecordId: null, entityType: null }).status).toBe("none");
  });
  it("sends a single-name team lead to review instead of guessing", () => {
    const d = deriveLeadAgentAliases({ ...BLU, companyName: "Christina Valkanoff Realty Group", teamLead: "Christina", contactName: "Christina Valkanoff" });
    expect(d.status).toBe(ENTITY_REVIEW_REQUIRED);
  });
  it("adds nothing when the team lead already equals the company name or an existing alias", () => {
    expect(deriveLeadAgentAliases({ ...BLU, companyName: "Josh May", teamLead: "Josh May", contactName: null }).status).toBe("none");
    expect(deriveLeadAgentAliases({ ...BLU, existingAliases: ["Ryan John Ogle", "ryan ogle"] }).status).toBe("none");
  });
  it("states the relationship as an identity fact without changing the prompt template", () => {
    expect(identityFactFor(BLU)).toContain("led by Ryan Ogle");
    expect(identityFactFor(BLU)).toContain("RealTrends 2025");
    expect(identityFactFor({ ...BLU, entityType: "individual" })).toBeNull();
  });
});

describe("recall with the alias in place (the bug and the fix, same answer text)", () => {
  const answer =
    "Based on Zillow’s Fuller Avenue agent directory, several local agents have Fuller Avenue sales, including Ryan Ogle (14 team sales in Fuller Avenue), Steve Volkers (7), Josh May (7), and Mike Smallegan (6).";
  const before = { id: BLU.companyId, name: BLU.companyName, aliases: [] as string[] };
  const after = { ...before, aliases: ["Ryan John Ogle", "Ryan Ogle"] };
  const josh = { id: "9081edd5-0ff0-4614-9358-bab85ac9caf4", name: "Josh May", aliases: [] as string[] };
  it("reproduces the undercount: without the alias the team is not even a candidate", () => {
    expect(scanAliases(answer, [before, josh]).map((h) => h.companyId)).toEqual([josh.id]);
  });
  it("credits the team through the alias, once, even when both names appear", () => {
    const both = `${answer} The Blu House Properties team is led by Ryan Ogle.`;
    const hits = scanAliases(both, [after, josh]);
    expect(hits.filter((h) => h.companyId === after.id)).toHaveLength(1);
    expect(hits.find((h) => h.companyId === after.id)?.tier).toBe("canonical");
    expect(scanAliases(answer, [after, josh]).find((h) => h.companyId === after.id)?.tier).toBe("alias");
  });
  it("does not merge an unrelated agent with a similar name", () => {
    expect(scanAliases("Darla Ogle of Ogle Luxury Group serves Santa Rosa Beach.", [after, josh])).toHaveLength(0);
  });
});
