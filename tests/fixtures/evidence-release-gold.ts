/**
 * Gold regression set for evidence release (spec 136). Small, high quality,
 * engineering QA only — NOT a statistical accuracy set. Each case pins one
 * property of the canonical credit rule: an answer credits a canonical
 * entity at most once, only when the classifier's current revision says
 * recommended, only through verified identity (name, registry alias,
 * licensed RealTrends team lead), never through similarity, and a verified
 * name in the raw text with no mention row is an unreconciled occurrence.
 *
 * Seeded from real incidents: Blu House / Ryan Ogle (2026-09-05 undercount,
 * 11 → 29 of 256), Tina Caul / Matina F Caul (nickname via primary contact),
 * Darla Ogle (same surname, different person), Compass (brokerage branding
 * vs agent recommendation), prompt echo.
 */
import type { ShadowCompany, ShadowMention, ShadowResponse } from "@/lib/prospects/evidence-release";

export const BLU = "85eba138-983b-4eec-b615-d56cf0c4dfe3";
export const JOSH = "9081edd5-0ff0-4614-9358-bab85ac9caf4";
export const CAUL = "c0000000-0000-4000-8000-000000000001";
export const EGAN = "c0000000-0000-4000-8000-000000000002";
export const COMPASS = "c0000000-0000-4000-8000-000000000003";

export const GOLD_COMPANIES: Record<string, ShadowCompany> = {
  [BLU]: { id: BLU, name: "Blu House Properties", aliases: ["Ryan John Ogle", "Ryan Ogle"], identityNames: ["Ryan John Ogle", "Ryan Ogle"] },
  [JOSH]: { id: JOSH, name: "Josh May", aliases: [], identityNames: [] },
  [CAUL]: { id: CAUL, name: "The Caul Group", aliases: ["Matina F Caul", "Matina Caul", "Tina Caul"], identityNames: ["Matina F Caul", "Matina Caul", "Tina Caul"] },
  [EGAN]: { id: EGAN, name: "Daniel Egan", aliases: [], identityNames: [] },
  [COMPASS]: { id: COMPASS, name: "Compass", aliases: [], identityNames: [] },
};

export interface GoldCase {
  id: string;
  description: string;
  /** The captured answer (input). */
  response: Pick<ShadowResponse, "promptText" | "responseText">;
  /** Canonical measured entity. */
  companyId: string;
  /** The classifier's current-revision row for (answer, entity); null when
   * the parser never considered the entity. */
  mention: Pick<ShadowMention, "mentioned" | "recommended"> | null;
  expected: {
    /** A verified identity name appears in the raw text. */
    occurrence: boolean;
    /** Canonical credit for recommendation frequency (0 or 1, never more). */
    credit: 0 | 1;
    /** Raw occurrence with no row → must be reconciled before release. */
    coverageGap: boolean;
  };
  /** Why this is the right answer; where the identity comes from. */
  provenance: string;
}

export const GOLD_CASES: GoldCase[] = [
  {
    id: "blu-team-name-only",
    description: "team named directly, recommended",
    response: { promptText: "Who should sell my townhome in Michigan Oaks?", responseText: "Blu House Properties is a strong choice for Michigan Oaks sellers." },
    companyId: BLU, mention: { mentioned: true, recommended: true },
    expected: { occurrence: true, credit: 1, coverageGap: false },
    provenance: "canonical company name; classifier recommended",
  },
  {
    id: "blu-lead-name-only",
    description: "only the team lead is named; the lead is a verified alias (RealTrends team_lead)",
    response: { promptText: "Who should sell my townhome in Michigan Oaks?", responseText: "Ryan Ogle (EXP) stands out with 11 team sales this year." },
    companyId: BLU, mention: { mentioned: true, recommended: true },
    expected: { occurrence: true, credit: 1, coverageGap: false },
    provenance: "realtrends_records.team_lead = 'Ryan John Ogle' on a confirmed TEAM record → alias 'Ryan Ogle' (spec 130)",
  },
  {
    id: "blu-lead-name-only-unconsidered",
    description: "the 2026-09-05 failure: lead named, no mention row — must surface as a coverage gap, never a silent 0",
    response: { promptText: "Who should sell my townhome in Michigan Oaks?", responseText: "Strong candidates include Ryan Ogle, Mark Brace and Josh May." },
    companyId: BLU, mention: null,
    expected: { occurrence: true, credit: 0, coverageGap: true },
    provenance: "22 answers named Ryan Ogle with no row while Touch 1 stated 11 of 256",
  },
  {
    id: "blu-team-and-lead-same-answer",
    description: "team and lead both named — one credit, not two",
    response: { promptText: "q", responseText: "Ryan Ogle at Blu House Properties … Ryan Ogle's team also handles Ada." },
    companyId: BLU, mention: { mentioned: true, recommended: true },
    expected: { occurrence: true, credit: 1, coverageGap: false },
    provenance: "one mention row per (answer, company); duplicate references collapse",
  },
  {
    id: "darla-ogle-unrelated",
    description: "unrelated agent sharing the surname is not the team",
    response: { promptText: "q", responseText: "Darla Ogle leads Ogle Luxury Group in Santa Rosa Beach." },
    companyId: BLU, mention: null,
    expected: { occurrence: false, credit: 0, coverageGap: false },
    provenance: "no verified name matches; surname similarity is not identity",
  },
  {
    id: "caul-verified-nickname",
    description: "verified nickname (primary contact, same family name as the licensed lead) credits the team",
    response: { promptText: "q", responseText: "Tina Caul's group is consistently recommended for Cary relocations." },
    companyId: CAUL, mention: { mentioned: true, recommended: true },
    expected: { occurrence: true, credit: 1, coverageGap: false },
    provenance: "prospect_contacts primary 'Tina Caul' + realtrends team_lead 'Matina F Caul' (same last name) → alias",
  },
  {
    id: "caul-unverified-nickname",
    description: "an unverified nickname is not an identity name — nothing matches, nothing is inferred",
    response: { promptText: "q", responseText: "Teenie Caul is a local favourite." },
    companyId: CAUL, mention: null,
    expected: { occurrence: false, credit: 0, coverageGap: false },
    provenance: "no authoritative source for 'Teenie'; fails closed as absent, never merged",
  },
  {
    id: "egan-individual-agent",
    description: "individual agent named and recommended",
    response: { promptText: "q", responseText: "Daniel Egan is often the first name mentioned for Hoboken condos." },
    companyId: EGAN, mention: { mentioned: true, recommended: true },
    expected: { occurrence: true, credit: 1, coverageGap: false },
    provenance: "RealTrends individual record; canonical two-token person name",
  },
  {
    id: "compass-brokerage-mention-vs-agent",
    description: "brokerage branding mentioned, not recommended — no credit to the brokerage, none to any agent",
    response: { promptText: "q", responseText: "Many top agents here are affiliated with Compass or Sotheby's." },
    companyId: COMPASS, mention: { mentioned: true, recommended: false },
    expected: { occurrence: true, credit: 0, coverageGap: false },
    provenance: "mention ≠ recommendation; entity levels are never merged by shared branding",
  },
  {
    id: "prompt-echo-excluded",
    description: "the question itself named the company — the answer's endorsement measures our prompt, not visibility",
    response: { promptText: "Is Josh May a good agent in Grand Rapids?", responseText: "Yes, Josh May is highly rated." },
    companyId: JOSH, mention: { mentioned: true, recommended: true },
    expected: { occurrence: true, credit: 0, coverageGap: false },
    provenance: "organic echo rule (lib/scoring/prompt-echo.ts)",
  },
  {
    id: "mentioned-not-recommended",
    description: "listed in passing without endorsement",
    response: { promptText: "q", responseText: "Josh May also shows multiple sales on Zillow." },
    companyId: JOSH, mention: { mentioned: true, recommended: false },
    expected: { occurrence: true, credit: 0, coverageGap: false },
    provenance: "classifier recommended=false; directory-style listing",
  },
  {
    id: "zero-no-occurrence",
    description: "a true zero: searched, absent, no row needed",
    response: { promptText: "q", responseText: "Consider Mark Brace or the Kellerman Group." },
    companyId: BLU, mention: null,
    expected: { occurrence: false, credit: 0, coverageGap: false },
    provenance: "all verified names searched; none present",
  },
];
