/**
 * Prospect ↔ company entity resolution (spec 041), pure. Reuses the
 * platform's one name matcher (lib/knowledge/normalize.ts) — no second
 * matching algorithm — and adds the two signals prospects have that mentions
 * don't: a website domain and a brokerage affiliation.
 *
 * The rule that shapes this module: **a brokerage mention is not an agent
 * mention.** A company whose match is explained by the prospect's brokerage
 * affiliation is excluded from candidacy and reported, with the reason,
 * rather than silently linked. And ambiguity stays ambiguous: two equal top
 * scores yield `possible`, never a coin toss (the normalize.ts philosophy).
 */
import {
  normalizeDomain,
  normalizeEntityName,
  scoreNameMatch,
} from "@/lib/knowledge/normalize";

export const RESOLVER_VERSION = "prospect-resolver-v1";

/** Verdict thresholds — top confidence at or above. */
export const MATCH_THRESHOLD = 0.85;
export const POSSIBLE_THRESHOLD = 0.5;

const DOMAIN_WEIGHT = 0.95;
const NAME_WEIGHTS: Record<string, number> = {
  exact: 0.9,
  probable: 0.65,
  ambiguous: 0.45,
  unmatched: 0,
};
const AGREEMENT_BONUS = 0.05;
const LEADER_BONUS = 0.1;

export interface ResolveInput {
  businessName: string;
  website?: string | null;
  brokerageAffiliation?: string | null;
  teamLeader?: string | null;
}

export interface CompanyRef {
  id: string;
  name: string;
  aliases: string[];
  domain: string | null;
}

export interface CompanyCandidateScore {
  companyId: string;
  name: string;
  confidence: number;
  reasons: string[];
}

export interface CompanyResolution {
  version: typeof RESOLVER_VERSION;
  verdict: "match" | "possible" | "none";
  companyId: string | null;
  companyName: string | null;
  confidence: number;
  reasons: string[];
  /** All scoring candidates, best first — surfaced on ties. */
  candidates: CompanyCandidateScore[];
  /** Companies excluded because only the brokerage affiliation matched. */
  brokerageCollisions: { companyId: string; name: string; reason: string }[];
}

/** Best name-match confidence for a string across a company's name+aliases. */
function nameScore(candidate: string, company: CompanyRef): { score: number; via: string } {
  let best = { score: 0, via: "" };
  for (const known of [company.name, ...company.aliases]) {
    const match = scoreNameMatch(candidate, known);
    const score = NAME_WEIGHTS[match.matchStatus] ?? 0;
    if (score > best.score) {
      best = { score, via: known === company.name ? "name" : `alias "${known}"` };
    }
  }
  return best;
}

export function resolveProspectCompany(
  input: ResolveInput,
  companies: CompanyRef[]
): CompanyResolution {
  const website = input.website ? normalizeDomain(input.website) : null;
  const leaderTokens = input.teamLeader
    ? normalizeEntityName(input.teamLeader).split(" ").filter((t) => t.length > 2)
    : [];

  const candidates: CompanyCandidateScore[] = [];
  const brokerageCollisions: CompanyResolution["brokerageCollisions"] = [];

  for (const company of companies) {
    const name = nameScore(input.businessName, company);
    const domainMatch =
      website !== null &&
      company.domain !== null &&
      normalizeDomain(company.domain) === website;
    const brokerage = input.brokerageAffiliation
      ? nameScore(input.brokerageAffiliation, company)
      : { score: 0, via: "" };

    // The brokerage rule: if the affiliation explains this company at least
    // as well as the business name does, and no domain ties them, the match
    // is the brokerage — not this prospect's identity.
    if (brokerage.score > 0 && brokerage.score >= name.score && !domainMatch) {
      brokerageCollisions.push({
        companyId: company.id,
        name: company.name,
        reason: `Matches the brokerage affiliation "${input.brokerageAffiliation}" (${brokerage.via}) — a brokerage is not the team.`,
      });
      continue;
    }

    const reasons: string[] = [];
    let confidence = 0;
    if (domainMatch) {
      confidence = DOMAIN_WEIGHT;
      reasons.push(`Website domain ${website} equals the company's domain.`);
    }
    if (name.score > 0) {
      if (name.score > confidence) confidence = name.score;
      reasons.push(
        `Business name matches the company ${name.via} (weight ${name.score.toFixed(2)}).`
      );
    }
    if (domainMatch && name.score > 0) {
      confidence = Math.min(1, confidence + AGREEMENT_BONUS);
      reasons.push("Domain and name agree.");
    }
    if (confidence > 0 && leaderTokens.length > 0) {
      const companyNorm = normalizeEntityName(company.name);
      if (leaderTokens.some((t) => companyNorm.includes(t))) {
        confidence = Math.min(1, confidence + LEADER_BONUS);
        reasons.push(`Team leader "${input.teamLeader}" appears in the company name.`);
      }
    }
    if (confidence > 0) {
      candidates.push({ companyId: company.id, name: company.name, confidence, reasons });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  const top = candidates[0];
  if (!top || top.confidence < POSSIBLE_THRESHOLD) {
    return {
      version: RESOLVER_VERSION,
      verdict: "none",
      companyId: null,
      companyName: null,
      confidence: top?.confidence ?? 0,
      reasons: top?.reasons ?? ["No tracked company matches this prospect."],
      candidates,
      brokerageCollisions,
    };
  }
  const tie = candidates[1] && candidates[1].confidence === top.confidence;
  const verdict = !tie && top.confidence >= MATCH_THRESHOLD ? "match" : "possible";
  return {
    version: RESOLVER_VERSION,
    verdict,
    companyId: verdict === "match" ? top.companyId : null,
    companyName: top.name,
    confidence: top.confidence,
    reasons: tie
      ? [
          `Two companies score equally (${top.name}, ${candidates[1]!.name}) — ambiguity needs a human.`,
          ...top.reasons,
        ]
      : top.reasons,
    candidates,
    brokerageCollisions,
  };
}
