/**
 * Parse pipeline (spec 004): the parse_response job handler. Writes
 * current-revision mentions + the parse ledger row, maintains sources, and
 * enqueues compute_scores once the run is fully parsed and review-clear.
 */
import { sql } from "@/db/client";
import { enqueueJob } from "@/db/jobs";
import { listCompaniesForProject, getSubjectCompany } from "@/db/companies";
import { pendingReviewCount } from "@/db/mentions";
import { classifyResponse } from "@/lib/parsing/classify";
import { classifyResponseLlm } from "@/lib/parsing/classify-llm";
import { extractUrls, urlDomain } from "@/lib/parsing/prepass";
import {
  detectBrandCandidates,
  normalizeCandidate,
} from "@/lib/parsing/candidates";
import { extractCitations } from "@/lib/ai/citations";
import { activeParserVersion, llmClassificationAvailable } from "@/lib/parsing/version";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";

export async function parseResponse(responseId: string): Promise<void> {
  const [response] = await sql`
    select r.id, r.run_id, r.response_text, r.prompt_text, r.error,
      r.raw_payload, r.provider, runs.project_id
    from responses r join runs on runs.id = r.run_id
    where r.id = ${responseId}
  `;
  if (!response) {
    throw new ClassifiedError("not_found", `Response ${responseId} not found.`);
  }

  // Project-scoped companies: the subject + non-subject registry companies —
  // other clients' subjects never enter this project's parse (spec 008)
  const projectId = response.projectId as string;
  const subject = await getSubjectCompany(projectId);
  if (!subject) {
    // Parse refuses without a configured client subject (specs 004 + 008)
    throw new ClassifiedError(
      "validation",
      "Project has no subject company — set the client under Knowledge before parsing (legacy is_self also satisfies this)."
    );
  }
  const companies = await listCompaniesForProject(projectId);

  const alreadyParsed = await sql`
    select 1 from response_parses
    where response_id = ${responseId} and parser_version = ${activeParserVersion()}
  `;
  if (alreadyParsed.length > 0) {
    await maybeEnqueueScoring(response.runId as string);
    return;
  }

  // Failed captures and refusals parse to no mentions but still count as parsed
  const text = (response.error ? "" : ((response.responseText as string) ?? "")) as string;
  const companyInputs = companies.map((c) => ({
    id: c.id,
    name: c.name,
    aliases: c.aliases,
    domain: c.domain,
  }));

  // v2: LLM entity resolution (spec 013) with approved claims as identity
  // ground truth; degrades to heuristic v1 without a key (docs/12).
  let drafts;
  if (llmClassificationAvailable() && text.trim().length > 0) {
    const claimRows = await sql`
      select canonical_text from claims
      where project_id = ${projectId} and status = 'approved'
      order by key asc
    `;
    const identityContext: Record<string, string[]> = {
      [subject.id]: claimRows.map((c) => c.canonicalText as string),
    };
    try {
      drafts = await classifyResponseLlm({
        responseText: text,
        promptText: (response.promptText as string) ?? "",
        companies: companyInputs,
        identityContext,
      });
    } catch (err) {
      // Never fail a parse on classifier trouble — fall back and record it
      log("warn", "parse.llm_classifier_failed", {
        responseId,
        error: err instanceof Error ? err.message : "unknown",
      });
      drafts = classifyResponse(text, companyInputs);
    }
  } else {
    drafts = classifyResponse(text, companyInputs);
  }

  // Search citations from the immutable payload (lib/ai/citations): the
  // provider's actual retrieval sources. Company-attributed by domain.
  const searchCitations = response.error
    ? []
    : extractCitations(response.provider as string, response.rawPayload);
  for (const draft of drafts) {
    if (!draft.mentioned) continue;
    const company = companies.find((c) => c.id === draft.companyId);
    if (!company?.domain) continue;
    const owned = searchCitations
      .filter((c) => c.domain.endsWith(company.domain as string))
      .map((c) => c.url);
    if (owned.length > 0) {
      draft.citedUrls = [...new Set([...draft.citedUrls, ...owned])];
    }
  }

  await sql.begin(async (tx) => {
    // Re-parse supersession: companies previously mentioned but no longer hit
    // get a retraction revision (originals stay — docs/03 revision model)
    const previous = await tx`
      select distinct company_id from mentions
      where response_id = ${responseId} and mentioned
    `;
    const draftIds = new Set(drafts.map((d) => d.companyId));
    for (const prev of previous) {
      if (draftIds.has(prev.companyId as string)) continue;
      await tx`
        insert into mentions
          (response_id, company_id, revision, mentioned, parser_version,
           confidence, needs_review)
        values
          (${responseId}, ${prev.companyId},
           (select max(revision) from mentions
            where response_id = ${responseId} and company_id = ${prev.companyId}) + 1,
           false, ${activeParserVersion()}, 0.85, false)
      `;
    }

    for (const draft of drafts) {
      // Revision = 1 + latest existing (re-parse after alias changes appends)
      await tx`
        insert into mentions
          (response_id, company_id, revision, mentioned, recommended,
           list_position, sentiment, excerpt, cited_urls, parser_version,
           confidence, needs_review)
        values
          (${responseId}, ${draft.companyId},
           coalesce((select max(revision) from mentions
             where response_id = ${responseId} and company_id = ${draft.companyId}), 0) + 1,
           ${draft.mentioned}, ${draft.recommended}, ${draft.listPosition},
           ${draft.sentiment}, ${draft.excerpt}, ${draft.citedUrls},
           ${activeParserVersion()}, ${draft.confidence}, ${draft.needsReview})
      `;
    }

    // Source intelligence: upsert every cited URL — in-text links plus the
    // search citations the provider actually retrieved (spec 004 / docs/03).
    // Scoped per project (migration 029): the same URL is a separate row with
    // a separate counter for each client, so citation counts never blend
    // across clients.
    const inTextUrls = extractUrls(text);
    const searchUrls = searchCitations.map((c) => c.url);
    const allUrls = [...new Set([...inTextUrls, ...searchUrls])];
    for (const url of allUrls) {
      const domain = urlDomain(url);
      if (!domain) continue;
      const owner = companies.find((c) => c.domain && domain.endsWith(c.domain));
      await tx`
        insert into sources (project_id, url, domain, company_id, citation_count)
        values (${projectId}, ${url}, ${domain}, ${owner?.id ?? null}, 1)
        on conflict (project_id, url) where project_id is not null do update set
          citation_count = sources.citation_count + 1,
          last_seen_at = now()
      `;
    }
    // Per-response ledger (migration 033): the join the counter above throws
    // away. A URL both written in the answer AND retrieved by search gets a
    // row per kind — those are different citation facts.
    const citationRows: { url: string; kind: "in_text" | "search" }[] = [
      ...[...new Set(inTextUrls)].map((url) => ({
        url,
        kind: "in_text" as const,
      })),
      ...[...new Set(searchUrls)].map((url) => ({
        url,
        kind: "search" as const,
      })),
    ];
    for (const row of citationRows) {
      const domain = urlDomain(row.url);
      if (!domain) continue;
      const owner = companies.find((c) => c.domain && domain.endsWith(c.domain));
      await tx`
        insert into response_citations (response_id, url, domain, kind, company_id)
        values (${responseId}, ${row.url}, ${domain}, ${row.kind}, ${owner?.id ?? null})
        on conflict (response_id, url, kind) do nothing
      `;
    }

    // Unrecognized-brand discovery (spec 005): surfaced for human promotion,
    // never auto-tracked (PRINCIPLES.md #8). Also project-scoped: which
    // brands surface in a client's answers is that client's intelligence.
    const knownTerms = companies.flatMap((c) => [c.name, ...c.aliases]);
    for (const candidate of detectBrandCandidates(text, knownTerms)) {
      await tx`
        insert into brand_candidates (project_id, name, normalized, first_seen_run_id)
        values (${projectId}, ${candidate}, ${normalizeCandidate(candidate)}, ${response.runId})
        on conflict (project_id, normalized) where project_id is not null do update set
          hit_count = brand_candidates.hit_count + 1,
          last_seen_at = now()
      `;
    }

    await tx`
      insert into response_parses (response_id, run_id, parser_version)
      values (${responseId}, ${response.runId}, ${activeParserVersion()})
      on conflict do nothing
    `;
  });

  await maybeEnqueueScoring(response.runId as string);
}

/** Enqueue compute_scores when the run is fully parsed and review-clear. */
export async function maybeEnqueueScoring(runId: string): Promise<void> {
  const [run] = await sql`select status from runs where id = ${runId}`;
  if (!run || !["completed", "partial", "failed"].includes(run.status as string)) {
    return;
  }
  const [unparsed] = await sql`
    select count(*)::int as n from responses r
    where r.run_id = ${runId}
      and not exists (
        select 1 from response_parses p
        where p.response_id = r.id and p.parser_version = ${activeParserVersion()}
      )
  `;
  if ((unparsed?.n as number) > 0) return;
  if ((await pendingReviewCount(runId)) > 0) {
    log("info", "parse.scoring_blocked_on_review", { runId });
    return;
  }
  const [existing] = await sql`
    select 1 from jobs
    where type = 'compute_scores' and payload->>'runId' = ${runId}
      and status in ('queued', 'running')
  `;
  if (existing) return;
  await enqueueJob(sql, "compute_scores", { runId });
  log("info", "parse.scoring_enqueued", { runId });
}

/** Enqueue parse jobs for every unparsed response of a run. */
export async function enqueueParseJobs(runId: string): Promise<number> {
  const rows = await sql`
    select r.id from responses r
    where r.run_id = ${runId}
      and not exists (
        select 1 from response_parses p
        where p.response_id = r.id and p.parser_version = ${activeParserVersion()}
      )
  `;
  for (const row of rows) {
    await enqueueJob(sql, "parse_response", {
      responseId: row.id as string,
      runId,
    });
  }
  return rows.length;
}
