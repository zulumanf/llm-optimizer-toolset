/**
 * The visibility gap (spec 038): local real-world authority minus valuable
 * AI visibility, both 0–100, derived on read with the evidence behind each
 * side. The gap exists only when both components are measurable — a missing
 * side renders as "not measured", never as 0 or as a fake gap.
 */
import { sql } from "@/db/client";
import {
  authorityProfile,
  type AuthorityProfile,
  type AuthoritySignalInput,
} from "@/lib/prospects/authority";
import { valuableVisibility } from "@/lib/prospects/benchmark";
import type { ValuableVisibility } from "@/lib/scoring/valuable";

export interface GapSignalDetail {
  id: string;
  kind: string;
  label: string;
  provenance: string;
  scope: string;
  sourceUrl: string | null;
  /** Evidence classification (migration 074/085): independent,
   * self_reported, sponsored, derived. Null = legacy/unclassified. */
  sourceType: string | null;
}

export interface AuthorityGapView {
  authority: AuthorityProfile;
  /** Null when the prospect has no linked benchmark with a canonical company. */
  visibility: ValuableVisibility | null;
  /** authority.score − visibility.score; null unless both are measurable. */
  gap: number | null;
  benchmarkRunId: string | null;
  /** Every signal, keyed for evidence rendering (counted and excluded). */
  signals: GapSignalDetail[];
}

async function loadSignals(
  prospectId: string
): Promise<{ inputs: AuthoritySignalInput[]; details: GapSignalDetail[] }> {
  const rows = await sql`
    select id, kind, label, provenance, scope, confidence, source_url, source_type,
      value_number
    from prospect_authority_signals
    where prospect_id = ${prospectId}
    order by created_at asc
  `;
  return {
    inputs: rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as AuthoritySignalInput["kind"],
      provenance: r.provenance as AuthoritySignalInput["provenance"],
      scope: r.scope as "local" | "global",
      confidence: r.confidence === null ? null : Number(r.confidence),
      sourceType:
        (r.sourceType as AuthoritySignalInput["sourceType"]) ?? null,
      valueNumber: r.valueNumber === null ? null : Number(r.valueNumber),
    })),
    details: rows.map((r) => ({
      id: r.id as string,
      kind: r.kind as string,
      label: r.label as string,
      provenance: r.provenance as string,
      scope: r.scope as string,
      sourceUrl: (r.sourceUrl as string | null) ?? null,
      sourceType: (r.sourceType as string | null) ?? null,
    })),
  };
}

function compose(
  authority: AuthorityProfile,
  visibility: ValuableVisibility | null,
  benchmarkRunId: string | null,
  details: GapSignalDetail[]
): AuthorityGapView {
  const gap =
    authority.score !== null && visibility !== null && visibility.score !== null
      ? authority.score - visibility.score
      : null;
  return { authority, visibility, gap, benchmarkRunId, signals: details };
}

/** Gap against a specific run (the audit's benchmark). */
export async function authorityGapForRun(
  prospectId: string,
  runId: string,
  companyId: string
): Promise<AuthorityGapView> {
  const { inputs, details } = await loadSignals(prospectId);
  const visibility = await valuableVisibility(runId, companyId);
  return compose(authorityProfile(inputs), visibility, runId, details);
}

/** Gap against the prospect's most recent linked benchmark, when one exists. */
export async function authorityGapForProspect(prospectId: string): Promise<AuthorityGapView> {
  const { inputs, details } = await loadSignals(prospectId);
  const [link] = await sql`
    select b.run_id, p.company_id
    from prospect_benchmarks b
    join prospects p on p.id = b.prospect_id
    where b.prospect_id = ${prospectId} and p.company_id is not null
    order by b.created_at desc
    limit 1
  `;
  const visibility = link
    ? await valuableVisibility(link.runId as string, link.companyId as string)
    : null;
  return compose(
    authorityProfile(inputs),
    visibility,
    (link?.runId as string | undefined) ?? null,
    details
  );
}
