/**
 * Finding-specific evidence resolution (spec 150). The ONE place outreach
 * learns how fresh a finding is and which AI providers actually stand
 * behind it: finding → its own benchmark → its own run. A newer benchmark
 * linked to the same prospect never makes an older finding fresh, and a
 * provider configured on the run but with zero valid answers is never named.
 */
import { sql } from "@/db/client";
import type { Sql, TransactionSql } from "@/db/client";
import { mockScoringAllowed } from "@/lib/ai/registry";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { providerDisplayName } from "@/lib/prospects/terminology";

const DAY_MS = 86_400_000;
const FINISHED_RUN_STATUSES = new Set(["completed", "partial"]);
/** Providers whose answers may be described to a prospect. Anything else
 * (including "mock") is excluded from copy and, if it is the only evidence,
 * fails the gate. */
const OUTREACH_PROVIDERS = new Set(["openai", "anthropic", "google", "perplexity"]);
/** Fabricated test captures count only behind the scoring fence (spec 050):
 * the test harness and local demos — refused under AUTH_MODE=supabase. */
const MOCK_PROVIDER = "mock";

export const FINDING_EVIDENCE_CODES = [
  "FINDING_NOT_FOUND",
  "FINDING_FOREIGN",
  "FINDING_NOT_APPROVED",
  "BENCHMARK_MISSING",
  "BENCHMARK_FOREIGN",
  "RUN_MISSING",
  "RUN_NOT_FINISHED",
  "RUN_TIMESTAMP_MISSING",
  "RUN_STALE",
  "NO_VALID_PROVIDER_EVIDENCE",
] as const;
export type FindingEvidenceCode = (typeof FINDING_EVIDENCE_CODES)[number];

export interface FindingEvidenceRow {
  findingId: string;
  findingProspectId: string;
  findingStatus: string;
  benchmarkId: string | null;
  benchmarkProspectId: string | null;
  runId: string | null;
  runStatus: string | null;
  runCompletedAt: Date | null;
}

export interface ProviderAnswerCount {
  provider: string;
  validAnswers: number;
}

export interface FindingEvidence {
  findingId: string;
  runId: string;
  completedAt: Date;
  ageDays: number;
  /** Providers with ≥1 valid answer, outreach-describable, stable order. */
  validProviders: string[];
  /** Prospect-readable names of validProviders ("OpenAI", "Perplexity"). */
  providerNames: string[];
}

export type FindingEvidenceVerdict =
  | { ok: true; evidence: FindingEvidence }
  | { ok: false; code: FindingEvidenceCode; detail: string };

const refuse = (code: FindingEvidenceCode, detail: string): FindingEvidenceVerdict => ({
  ok: false,
  code,
  detail,
});

/** Pure: judge one finding's evidence chain for one prospect. */
export function evaluateFindingEvidence(
  prospectId: string,
  row: FindingEvidenceRow | null,
  providerCounts: ProviderAnswerCount[],
  now: Date,
  maxAgeDays: number = MISMATCH_THRESHOLDS.maxBenchmarkAgeDays
): FindingEvidenceVerdict {
  if (!row) return refuse("FINDING_NOT_FOUND", "The draft's finding no longer exists.");
  if (row.findingProspectId !== prospectId) {
    return refuse("FINDING_FOREIGN", "The draft's finding belongs to a different prospect.");
  }
  if (row.findingStatus !== "approved") {
    return refuse("FINDING_NOT_APPROVED", `The draft's finding is ${row.findingStatus}, not approved.`);
  }
  if (!row.benchmarkId) {
    return refuse("BENCHMARK_MISSING", "The finding is not linked to a benchmark — its evidence cannot be dated.");
  }
  if (row.benchmarkProspectId !== prospectId) {
    return refuse("BENCHMARK_FOREIGN", "The finding's benchmark belongs to a different prospect.");
  }
  if (!row.runId) return refuse("RUN_MISSING", "The finding's benchmark has no run.");
  if (!row.runStatus || !FINISHED_RUN_STATUSES.has(row.runStatus)) {
    return refuse("RUN_NOT_FINISHED", `The finding's benchmark run is ${row.runStatus ?? "unknown"}, not finished.`);
  }
  if (!row.runCompletedAt) {
    return refuse("RUN_TIMESTAMP_MISSING", "The finding's benchmark run has no completion time — freshness cannot be shown.");
  }
  const ageDays = (now.getTime() - row.runCompletedAt.getTime()) / DAY_MS;
  if (ageDays > maxAgeDays) {
    return refuse(
      "RUN_STALE",
      `The finding comes from a benchmark ${Math.floor(ageDays)} days old — over the ${maxAgeDays}-day maximum. A newer benchmark does not refresh it: regenerate and approve a finding from a current run.`
    );
  }
  const validProviders = providerCounts
    .filter(
      (p) =>
        p.validAnswers > 0 &&
        (OUTREACH_PROVIDERS.has(p.provider) || (p.provider === MOCK_PROVIDER && mockScoringAllowed()))
    )
    .map((p) => p.provider)
    .sort();
  if (validProviders.length === 0) {
    return refuse("NO_VALID_PROVIDER_EVIDENCE", "No AI provider returned valid answers in the finding's benchmark run.");
  }
  return {
    ok: true,
    evidence: {
      findingId: row.findingId,
      runId: row.runId,
      completedAt: row.runCompletedAt,
      ageDays,
      validProviders,
      providerNames: validProviders.map(providerDisplayName),
    },
  };
}

/** Resolve and judge the evidence behind one finding for one prospect. */
export async function resolveFindingEvidence(
  findingId: string | null,
  prospectId: string,
  opts: { db?: Sql | TransactionSql; now?: Date } = {}
): Promise<FindingEvidenceVerdict> {
  const db = opts.db ?? sql;
  const now = opts.now ?? new Date();
  if (!findingId) return evaluateFindingEvidence(prospectId, null, [], now);
  const [r] = await db`
    select f.id, f.prospect_id, f.status, f.benchmark_id,
      b.prospect_id as benchmark_prospect_id, b.run_id,
      r.status as run_status, r.completed_at
    from prospect_findings f
    left join prospect_benchmarks b on b.id = f.benchmark_id
    left join runs r on r.id = b.run_id
    where f.id = ${findingId}
  `;
  const row: FindingEvidenceRow | null = r
    ? {
        findingId: r.id as string,
        findingProspectId: r.prospectId as string,
        findingStatus: r.status as string,
        benchmarkId: (r.benchmarkId as string | null) ?? null,
        benchmarkProspectId: (r.benchmarkProspectId as string | null) ?? null,
        runId: (r.runId as string | null) ?? null,
        runStatus: (r.runStatus as string | null) ?? null,
        runCompletedAt: r.completedAt ? new Date(r.completedAt as Date) : null,
      }
    : null;
  const counts = row?.runId
    ? (
        await db`
          select provider, count(*)::int as valid_answers
          from responses
          where run_id = ${row.runId} and error is null
            and response_text is not null and response_text <> ''
          group by provider
        `
      ).map((c) => ({ provider: c.provider as string, validAnswers: Number(c.validAnswers) }))
    : [];
  return evaluateFindingEvidence(prospectId, row, counts, now);
}

/** Display names an email may use for a provider id (brand or consumer
 * counterpart). Used to catch copy naming a provider without evidence. */
export const PROVIDER_COPY_NAMES: Record<string, readonly string[]> = {
  openai: ["OpenAI", "ChatGPT"],
  anthropic: ["Anthropic", "Claude"],
  google: ["Gemini"],
  perplexity: ["Perplexity"],
};

/** Pure: providers a body names that have no valid evidence behind them. */
export function unsupportedProviderMentions(body: string, validProviders: readonly string[]): string[] {
  const out: string[] = [];
  for (const [provider, names] of Object.entries(PROVIDER_COPY_NAMES)) {
    if (validProviders.includes(provider)) continue;
    for (const name of names) {
      if (new RegExp(`\\b${name}\\b`).test(body)) out.push(name);
    }
  }
  return out;
}
