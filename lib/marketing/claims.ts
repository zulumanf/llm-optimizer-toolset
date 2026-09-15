/**
 * Approved public claims registry (marketing evidence guardrail). Every
 * number the public site prints comes from `approved-claims.json` through
 * this module — pages never hardcode a figure. `scripts/marketing-claims-verify.ts`
 * recounts each claim from the immutable measurement tables and flags drift.
 */
import registry from "./approved-claims.json";

export type ClaimValues = Record<string, number | string>;

export type ClaimVerification =
  | { query: "run_summary"; runId: string }
  | { query: "run_by_provider"; runId: string }
  | { query: "run_top_domains"; runId: string; limit?: number }
  | { query: "corpus_aggregate"; through: string }
  | { query: "corpus_top_domains"; limit?: number; through: string }
  | { query: "corpus_source_classes"; through: string }
  | { query: "corpus_prompt_categories"; through: string }
  | { query: "production_contrast"; runId: string; subjectCompany: string; rivalCompany: string }
  | { query: "manual" };

export type ClaimStatus = "approved" | "pending_verification" | "internal_only";

export type ApprovedClaim = {
  id: string;
  status: ClaimStatus;
  claim: string;
  /** Internal source: run label(s), table, script — for the operator. */
  source: string;
  benchmarkDate: string;
  /** Market label; "17 U.S. markets" for corpus claims. Never mixed. */
  market: string;
  /** Instrument label(s) exactly as printed on public pages. */
  instrument: string;
  denominator: string;
  publicWording: string;
  prohibitedWording: string[];
  anonymization: string;
  /** Domain keys withheld from public tables (prospect-owned or unverified). */
  publicExclude?: string[];
  lastVerified: string;
  /** Dated notes of value changes (recounts after classification revisions). */
  updateHistory?: { date: string; note: string }[];
  values: ClaimValues;
  verification: ClaimVerification;
};

export const APPROVED_CLAIMS: readonly ApprovedClaim[] = (registry as { claims: unknown }).claims as ApprovedClaim[];

/** Registry-level metadata: dataset version the public tables must match, precedence rule in force. */
export const REGISTRY_META = registry as { version: number; updated: string; datasetVersion?: string; classificationPrecedence?: string };

export function claim(id: string): ApprovedClaim {
  const found = APPROVED_CLAIMS.find((c) => c.id === id);
  if (!found) throw new Error(`Unknown claim id: ${id}`);
  if (found.status !== "approved") throw new Error(`Claim ${id} is ${found.status}, not approved for public use`);
  return found;
}

/** Numeric value of an approved claim; throws rather than rendering a blank. */
export function claimNumber(id: string, key: string): number {
  const v = claim(id).values[key];
  if (typeof v !== "number") throw new Error(`Claim ${id} has no numeric value ${key}`);
  return v;
}

export function claimText(id: string, key: string): string {
  const v = claim(id).values[key];
  if (v === undefined) throw new Error(`Claim ${id} has no value ${key}`);
  return String(v);
}

/** Percent with no decimals, computed from two registry counts — the
 * denominator is always printed next to it by the caller. */
export function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "not measured";
  return `${Math.round((numerator / denominator) * 100)}%`;
}

/** Domain rows of a claim as a sorted public table, honouring publicExclude. */
export function domainRows(id: string): { domain: string; total: number; openai?: number; perplexity?: number }[] {
  const c = claim(id);
  const excluded = new Set(c.publicExclude ?? []);
  const rows: { domain: string; total: number; openai?: number; perplexity?: number }[] = [];
  for (const [key, value] of Object.entries(c.values)) {
    const parts = key.split(":");
    if (parts[0] !== "domain" || parts.length !== 2 || typeof value !== "number") continue;
    const domain = parts[1] as string;
    if (excluded.has(domain)) continue;
    const oa = c.values[`domain:${domain}:openai`];
    const px = c.values[`domain:${domain}:perplexity`];
    rows.push({
      domain,
      total: value,
      ...(typeof oa === "number" ? { openai: oa } : {}),
      ...(typeof px === "number" ? { perplexity: px } : {}),
    });
  }
  return rows.sort((a, b) => b.total - a.total || a.domain.localeCompare(b.domain));
}
