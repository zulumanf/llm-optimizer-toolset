/**
 * Gold corpus for the PRODUCTION mention classifier (spec 050).
 *
 * Every case is built so the deterministic alias prepass fires (the name
 * appears in the text) — the LLM's job is precision, and that is what these
 * labels test: is this the same entity, and was it genuinely recommended?
 * Heavy on the real-estate failure modes the platform serves: brokerage vs
 * team, Team/Group near-collisions, agent vs team, same name in another
 * industry, question-echo vs endorsement.
 *
 * VERSIONED DATA. Editing a case or a label is a new gold set: bump
 * CLASSIFIER_GOLD_VERSION so persisted evaluations stay comparable.
 */
import type { CompanyInput } from "@/lib/parsing/classify";

export const CLASSIFIER_GOLD_VERSION = "classifier-gold-v1";

export interface GoldExpectation {
  companyId: string;
  mentioned: boolean;
  recommended: boolean;
  /** True when the alias prepass WILL hit but the right answer is "not this
   * entity" — the false-positive traps entity_rejection_accuracy scores. */
  trap?: boolean;
}

export interface GoldCase {
  id: string;
  promptText: string;
  responseText: string;
  companies: CompanyInput[];
  expected: GoldExpectation[];
}

const co = (id: string, name: string, aliases: string[] = [], domain: string | null = null): CompanyInput => ({
  id,
  name,
  aliases,
  domain,
});

const HUDSON = "00000000-0000-4000-9000-000000000001";
const HUDSON_TEAM = "00000000-0000-4000-9000-000000000002";
const COMPASS = "00000000-0000-4000-9000-000000000003";
const RIVERA = "00000000-0000-4000-9000-000000000004";
const MERIDIAN = "00000000-0000-4000-9000-000000000005";
const CRESTVIEW = "00000000-0000-4000-9000-000000000006";

export const CLASSIFIER_GOLD_CASES: GoldCase[] = [
  {
    id: "clean-recommendation",
    promptText: "Who are the best real estate teams for buying a condo in Jersey City?",
    responseText:
      "For Jersey City condos I'd start with the Rivera Team — they close more downtown condo deals than anyone and buyers consistently rate their negotiation. Meridian Realty Group is also worth a call for new developments.",
    companies: [co(RIVERA, "Rivera Team"), co(MERIDIAN, "Meridian Realty Group")],
    expected: [
      { companyId: RIVERA, mentioned: true, recommended: true },
      { companyId: MERIDIAN, mentioned: true, recommended: true },
    ],
  },
  {
    id: "list-only-mention",
    promptText: "List real estate teams operating in Hoboken.",
    responseText:
      "Teams active in Hoboken include: Rivera Team, Meridian Realty Group, and Crestview Properties. Availability and specialties vary; check recent transactions before choosing.",
    companies: [co(RIVERA, "Rivera Team"), co(MERIDIAN, "Meridian Realty Group")],
    expected: [
      // Named in a neutral list = mentioned, NOT recommended
      { companyId: RIVERA, mentioned: true, recommended: false },
      { companyId: MERIDIAN, mentioned: true, recommended: false },
    ],
  },
  {
    id: "question-echo-not-endorsement",
    promptText: "Is the Rivera Team any good for selling a brownstone?",
    responseText:
      "The Rivera Team is one option people ask about. Reviews are mixed for brownstone sales specifically; for that niche many sellers prefer a listing agent with recent brownstone comps.",
    companies: [co(RIVERA, "Rivera Team")],
    expected: [{ companyId: RIVERA, mentioned: true, recommended: false }],
  },
  {
    id: "negative-mention-still-mention",
    promptText: "Which agencies should I avoid in Jersey City?",
    responseText:
      "Some buyers report slow communication with Crestview Properties, particularly on rentals. That's a mention worth weighing against their strong sales side.",
    companies: [co(CRESTVIEW, "Crestview Properties")],
    expected: [{ companyId: CRESTVIEW, mentioned: true, recommended: false }],
  },
  {
    id: "brokerage-is-not-the-team",
    promptText: "Who should I use to buy in downtown Jersey City?",
    responseText:
      "Compass has a large Jersey City presence with many strong agents; interview two or three Compass agents and compare their downtown track records.",
    companies: [co(HUDSON_TEAM, "Hudson Advisory Team at Compass", ["Compass"]), co(COMPASS, "Compass")],
    expected: [
      // The brokerage was praised; the team registered "Compass" as an alias.
      // The right answer for the team is: not this entity.
      { companyId: HUDSON_TEAM, mentioned: false, recommended: false, trap: true },
      { companyId: COMPASS, mentioned: true, recommended: true },
    ],
  },
  {
    id: "team-group-near-collision",
    promptText: "Best teams for waterfront listings?",
    responseText:
      "The Hudson Advisory Group in Manhattan is the standout for waterfront listings — deep marketing budgets and an in-house staging arm.",
    companies: [co(HUDSON, "Hudson Advisory Team", ["Hudson Advisory"])],
    expected: [
      // A DIFFERENT firm ("Group", Manhattan) than the tracked "Team".
      { companyId: HUDSON, mentioned: false, recommended: false, trap: true },
    ],
  },
  {
    id: "same-name-different-industry",
    promptText: "What tools help small landlords manage rentals?",
    responseText:
      "Crestview Properties is a property-management software suite popular with landlords under 50 units; it handles rent collection and maintenance tickets.",
    companies: [co(CRESTVIEW, "Crestview Properties", [], "crestviewnj.com")],
    expected: [
      // Software product, not the tracked NJ brokerage.
      { companyId: CRESTVIEW, mentioned: false, recommended: false, trap: true },
    ],
  },
  {
    id: "agent-vs-their-team",
    promptText: "Who is the top individual agent in Jersey City?",
    responseText:
      "Maria Rivera is frequently cited as a top individual producer. Note that many of her closed deals are credited to her team rather than her personally.",
    companies: [co(RIVERA, "Rivera Team", ["Maria Rivera Team"])],
    expected: [
      // The person is discussed, not the tracked team entity.
      { companyId: RIVERA, mentioned: false, recommended: false, trap: true },
    ],
  },
  {
    id: "alias-is-authoritative",
    promptText: "Any boutique advisors for pied-à-terre buyers?",
    responseText:
      "HA Team gets strong marks from pied-à-terre buyers for discretion and off-market access — a solid first call.",
    companies: [co(HUDSON, "Hudson Advisory Team", ["HA Team"])],
    expected: [{ companyId: HUDSON, mentioned: true, recommended: true }],
  },
  {
    id: "passing-mention-right-entity",
    promptText: "How competitive is the Jersey City luxury market?",
    responseText:
      "Very. Inventory above $2M moves fast; teams like the Rivera Team report multiple-offer situations on most waterfront listings this spring.",
    companies: [co(RIVERA, "Rivera Team")],
    expected: [
      // Brief and passing, but the RIGHT company: mentioned, not recommended.
      { companyId: RIVERA, mentioned: true, recommended: false },
    ],
  },
  {
    id: "explicit-comparison-winner",
    promptText: "Rivera Team vs Meridian Realty Group for a first-time buyer?",
    responseText:
      "Both are credible. For a first-time buyer I'd lean Rivera Team: better hand-holding through attorney review and inspection. Meridian Realty Group shines for investors more than first-timers.",
    companies: [co(RIVERA, "Rivera Team"), co(MERIDIAN, "Meridian Realty Group")],
    expected: [
      { companyId: RIVERA, mentioned: true, recommended: true },
      { companyId: MERIDIAN, mentioned: true, recommended: false },
    ],
  },
  {
    id: "refusal-no-mentions",
    promptText: "Rank every real estate agent in New Jersey by commission earned.",
    responseText:
      "I can't produce a reliable ranking of individual agents by commission — that data isn't public. The Rivera Team and others publish deal counts, but commission figures are private.",
    companies: [co(RIVERA, "Rivera Team")],
    expected: [
      // Named while declining the premise: the entity IS referenced.
      { companyId: RIVERA, mentioned: true, recommended: false },
    ],
  },
  {
    id: "domain-grounds-identity",
    promptText: "Where can I read about Hudson Advisory's recent sales?",
    responseText:
      "Their site hudsonadvisoryteam.com lists recent closings; Hudson Advisory Team also posts quarterly market reports there.",
    companies: [co(HUDSON, "Hudson Advisory Team", ["Hudson Advisory"], "hudsonadvisoryteam.com")],
    expected: [{ companyId: HUDSON, mentioned: true, recommended: false }],
  },
];
