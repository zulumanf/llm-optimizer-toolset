/**
 * Parse pipeline (spec 004): the parse_response job handler. Writes
 * current-revision mentions + the parse ledger row, maintains sources, and
 * enqueues compute_scores once the run is fully parsed and review-clear.
 */
import { identityFactsFor } from "@/lib/prospects/entity-aliases";
import { sql } from "@/db/client";
import { enqueueJob } from "@/db/jobs";
import { listCompaniesForProject, getSubjectCompany } from "@/db/companies";
import { pendingReviewCount } from "@/db/mentions";
import { classifyResponse } from "@/lib/parsing/classify";
import { classifyResponseLlm } from "@/lib/parsing/classify-llm";
import { extractUrls, scanAliases, urlDomain } from "@/lib/parsing/prepass";
import {
  classifySource,
  SOURCE_CLASSIFIER_VERSION,
} from "@/lib/sources/classify";
import {
  detectBrandCandidates,
  normalizeCandidate,
} from "@/lib/parsing/candidates";
import { extractCitations } from "@/lib/ai/citations";
import {
  activeParserVersion,
  llmClassificationAvailable,
  KNOWN_PARSER_VERSIONS,
} from "@/lib/parsing/version";
import {
  PARSER_VERSION_HEURISTIC,
  PARSER_VERSION_LLM,
} from "@/lib/constants";
import { modelForTask } from "@/lib/ai/routing";
import { MENTION_CLASSIFIER_V2 } from "@/lib/parsing/classify-llm";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { ClassifierUnavailableError } from "@/lib/parsing/errors";
import { VERIFIED_PARSER_VERSIONS } from "@/lib/parsing/precedence";
import type { Sql, TransactionSql } from "@/db/client";

type Db = Sql | TransactionSql;

export interface ParseOptions {
  /** An explicit operator re-parse (reparseRun): re-run the parser even when
   * the judgments already exist. Default false — a missing ledger row whose
   * judgments exist is reconstructed, not re-classified. */
  reparse?: boolean;
}

export async function parseResponse(responseId: string, options: ParseOptions = {}): Promise<void> {
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
  // The judgments may already exist without their ledger row (the legacy
  // delete-and-reparse backfill removed ledgers, never mentions). Restore the
  // ledger from the immutable revisions instead of re-classifying.
  if (!options.reparse && await reconstructLedgerFromMentions(responseId, response.runId as string, activeParserVersion())) {
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
  // parserUsed records what ACTUALLY classified this response — a fallback
  // parse must stamp v1, not the version we hoped for (provenance is the
  // whole point of the stamp).
  let drafts;
  let parserUsed: string = PARSER_VERSION_HEURISTIC;
  // Instrument stamps (spec 050): parser_version names the family; these
  // name the actual classifier model + prompt version that judged the row.
  // Null = heuristic, no LLM instrument involved.
  let classifierModel: string | null = null;
  let classifierPromptVersion: string | null = null;
  if (llmClassificationAvailable() && text.trim().length > 0) {
    const claimRows = await sql`
      select canonical_text from claims
      where project_id = ${projectId} and status = 'approved'
      order by key asc
    `;
    // Spec 130: verified lead-agent relationships (RealTrends team lead) are
    // identity facts for every candidate, so a team named by its lead agent
    // resolves to the team instead of "a person, not the company".
    const identityContext: Record<string, string[]> = {
      ...(await identityFactsFor(companyInputs.map((c) => c.id))),
      [subject.id]: claimRows.map((c) => c.canonicalText as string),
    };
    try {
      drafts = await classifyResponseLlm({
        responseText: text,
        promptText: (response.promptText as string) ?? "",
        companies: companyInputs,
        identityContext,
        projectId,
      });
      parserUsed = PARSER_VERSION_LLM;
      classifierModel = modelForTask("mention_classification");
      classifierPromptVersion = MENTION_CLASSIFIER_V2;
    } catch (err) {
      // No downgrade (hardening 2026-09-14): a response that already carries
      // a classifier judgment keeps it — the parse is deferred, not degraded.
      if (await hasClassifierClassRows(sql, responseId)) {
        throw new ClassifierUnavailableError(err, `re-parsing response ${responseId}`);
      }
      // First parse of a response with no classifier history: the documented
      // graceful degradation (docs/12) — fall back, stamp truthfully.
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
           confidence, needs_review, classifier_model, classifier_prompt_version)
        values
          (${responseId}, ${prev.companyId},
           (select max(revision) from mentions
            where response_id = ${responseId} and company_id = ${prev.companyId}) + 1,
           false, ${parserUsed}, 0.85, false, ${classifierModel},
           ${classifierPromptVersion})
      `;
    }

    for (const draft of drafts) {
      // Revision = 1 + latest existing (re-parse after alias changes appends)
      await tx`
        insert into mentions
          (response_id, company_id, revision, mentioned, recommended,
           list_position, sentiment, excerpt, cited_urls, parser_version,
           confidence, needs_review, classifier_model, classifier_prompt_version)
        values
          (${responseId}, ${draft.companyId},
           coalesce((select max(revision) from mentions
             where response_id = ${responseId} and company_id = ${draft.companyId}), 0) + 1,
           ${draft.mentioned}, ${draft.recommended}, ${draft.listPosition},
           ${draft.sentiment}, ${draft.excerpt}, ${draft.citedUrls},
           ${parserUsed}, ${draft.confidence}, ${draft.needsReview},
           ${classifierModel}, ${classifierPromptVersion})
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
    const classificationContext = {
      subjectDomain: subject.domain?.toLowerCase() ?? null,
      competitorDomains: companies
        .filter((c) => c.id !== subject.id && c.domain)
        .map((c) => (c.domain as string).toLowerCase()),
    };
    for (const url of allUrls) {
      const domain = urlDomain(url);
      if (!domain) continue;
      const owner = companies.find((c) => c.domain && domain.endsWith(c.domain));
      const classified = classifySource(domain, classificationContext);
      await tx`
        insert into sources (project_id, url, domain, company_id, citation_count,
          source_type, relationship, classifier_version, classified_at)
        values (${projectId}, ${url}, ${domain}, ${owner?.id ?? null}, 1,
          ${classified.sourceType}, ${classified.relationship},
          ${SOURCE_CLASSIFIER_VERSION}, now())
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
      insert into response_parses
        (response_id, run_id, parser_version, classifier_model,
         classifier_prompt_version)
      values (${responseId}, ${response.runId}, ${parserUsed},
        ${classifierModel}, ${classifierPromptVersion})
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
  // Any known version counts as parsed: a truthfully-stamped degraded parse
  // must not stall scoring, and a key change must not silently reclassify
  // history as unparsed (production-readiness plan 2.1/2.2).
  const [unparsed] = await sql`
    select count(*)::int as n from responses r
    where r.run_id = ${runId}
      and not exists (
        select 1 from response_parses p
        where p.response_id = r.id
          and p.parser_version = any(${KNOWN_PARSER_VERSIONS})
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

/** Enqueue parse jobs for every unparsed response of a run. `reparse` marks
 * an explicit operator re-parse so the worker re-runs the parser instead of
 * reconstructing the ledger from existing judgments. */
export async function enqueueParseJobs(runId: string, options: ParseOptions = {}): Promise<number> {
  // Logical job identity = (response, active parser version): a response with
  // a queued/running parse job is not enqueued again (queue-level dedupe,
  // 2026-09-15 — a double refresh had queued 891 duplicates).
  const rows = await sql`
    select r.id from responses r
    where r.run_id = ${runId}
      and not exists (
        select 1 from response_parses p
        where p.response_id = r.id and p.parser_version = ${activeParserVersion()}
      )
      and not exists (
        select 1 from jobs j
        where j.type = 'parse_response' and j.status in ('queued', 'running')
          and j.payload->>'responseId' = r.id::text
      )
  `;
  for (const row of rows) {
    await enqueueJob(sql, "parse_response", {
      responseId: row.id as string,
      runId,
      ...(options.reparse ? { reparse: true } : {}),
    });
  }
  return rows.length;
}

/** A (response, company) pair already holds a classifier-class judgment
 * (LLM, adjudication, or human-reviewed). Heuristic-only pairs do NOT count:
 * they stay eligible for the classifier. */
export async function hasClassifierClassRows(db: Db, responseId: string, companyId?: string): Promise<boolean> {
  const rows = await db`
    select 1 from mentions
    where response_id = ${responseId}
      and (${companyId ?? null}::uuid is null or company_id = ${companyId ?? null})
      and (parser_version = any(${[...VERIFIED_PARSER_VERSIONS]}) or reviewed_by is not null)
    limit 1
  `;
  return rows.length > 0;
}

/**
 * Ledger reconstruction: when mention revisions stamped with `version`
 * exist for the response but its response_parses row is gone, re-insert the
 * ledger row from the revisions' own instrument stamps. Returns true when a
 * row was reconstructed (or already existed by the time we wrote).
 */
export async function reconstructLedgerFromMentions(responseId: string, runId: string, version: string): Promise<boolean> {
  const [stamp] = await sql`
    select classifier_model, classifier_prompt_version from mentions
    where response_id = ${responseId} and parser_version = ${version}
    order by (classifier_model is not null and classifier_prompt_version is not null) desc, created_at desc
    limit 1
  `;
  if (!stamp) return false;
  await sql`
    insert into response_parses
      (response_id, run_id, parser_version, classifier_model, classifier_prompt_version,
       reconstructed_from_mentions)
    values (${responseId}, ${runId}, ${version}, ${stamp.classifierModel ?? null},
      ${stamp.classifierPromptVersion ?? null}, true)
    on conflict do nothing
  `;
  log("info", "parse.ledger_reconstructed", { responseId, version });
  return true;
}

export interface CompanyParseResult {
  scanned: number;
  hits: number;
  /** Hits already holding a classifier-class judgment — reused, not re-judged. */
  reused: number;
  inserted: number;
  recommended: number;
  classifierCalls: number;
  parserVersion: string;
}

type CompanyInput = { id: string; name: string; aliases: string[]; domain: string | null };

/** One classifier (or policy-heuristic) judgment of one company in one answer. */
async function classifyCompanyInResponse(input: {
  text: string; promptText: string; company: CompanyInput; subjectId: string | null; projectId: string; responseId: string;
}) {
  const single = [input.company];
  if (!llmClassificationAvailable()) {
    return { drafts: classifyResponse(input.text, single), parserUsed: PARSER_VERSION_HEURISTIC as string, classifierModel: null as string | null, classifierPromptVersion: null as string | null, classifierCall: false };
  }
  try {
    const drafts = await classifyResponseLlm({
      responseText: input.text,
      promptText: input.promptText,
      companies: single,
      identityContext: { ...(await identityFactsFor([input.company.id])), ...(input.subjectId ? { [input.subjectId]: [] } : {}) },
      projectId: input.projectId,
    });
    return { drafts, parserUsed: PARSER_VERSION_LLM as string, classifierModel: modelForTask("mention_classification") as string | null, classifierPromptVersion: MENTION_CLASSIFIER_V2 as string | null, classifierCall: true };
  } catch (err) {
    // A key is configured, so the classifier is REQUIRED: defer, never degrade.
    throw new ClassifierUnavailableError(err, `classifying ${input.company.name} in response ${input.responseId}`);
  }
}

/**
 * Parse ONE tracked company into an already-parsed run (spec 124 cohort
 * pass, 2026-08-31; hardened 2026-09-14). The per-response parse ledger is
 * append-once per parser version, so a company promoted AFTER a run was
 * parsed would otherwise never receive mention rows for it. Runs the active
 * classifier scoped to the one company, over only the responses whose text
 * names it (the parser's own whole-word prepass — an unnamed company's
 * truthful state is "no row", which every counter reads as zero). Pairs that
 * already hold a classifier-class judgment are reused untouched; heuristic-
 * only pairs are upgraded. With a classifier key configured, a classifier
 * failure throws ClassifierUnavailableError before anything is written for
 * that pair — nothing heuristic is ever written in place of a classifier.
 * Inserts append normal mention revisions; nothing existing is modified.
 */
export async function parseCompanyIntoRun(
  runId: string,
  companyId: string,
  db: Db = sql
): Promise<CompanyParseResult> {
  const [run] = await db`select id, project_id from runs where id = ${runId}`;
  if (!run) throw new ClassifiedError("not_found", `Run ${runId} not found.`);
  const projectId = run.projectId as string;
  const companies = await listCompaniesForProject(projectId);
  const company = companies.find((c) => c.id === companyId);
  if (!company) {
    throw new ClassifiedError(
      "validation",
      "Company is not tracked in this run's project — add it as a competitor first."
    );
  }
  const subject = await getSubjectCompany(projectId);
  const responses = await db`
    select r.id, r.response_text, r.prompt_text from responses r
    where r.run_id = ${runId} and r.error is null
  `;
  const input: CompanyInput = { id: company.id, name: company.name, aliases: company.aliases, domain: company.domain };
  const out: CompanyParseResult = { scanned: responses.length, hits: 0, reused: 0, inserted: 0, recommended: 0, classifierCalls: 0, parserVersion: activeParserVersion() };
  for (const response of responses) {
    const text = (response.responseText as string) ?? "";
    if (scanAliases(text, [input]).length === 0) continue;
    out.hits += 1;
    if (await hasClassifierClassRows(db, response.id as string, companyId)) { out.reused += 1; continue; }
    const judged = await classifyCompanyInResponse({
      text, promptText: (response.promptText as string) ?? "", company: input,
      subjectId: subject?.id ?? null, projectId, responseId: response.id as string,
    });
    if (judged.classifierCall) out.classifierCalls += 1;
    for (const draft of judged.drafts) {
      await db`
        insert into mentions
          (response_id, company_id, revision, mentioned, recommended,
           list_position, sentiment, excerpt, cited_urls, parser_version,
           confidence, needs_review, classifier_model, classifier_prompt_version)
        values
          (${response.id}, ${draft.companyId},
           coalesce((select max(revision) from mentions
             where response_id = ${response.id} and company_id = ${draft.companyId}), 0) + 1,
           ${draft.mentioned}, ${draft.recommended}, ${draft.listPosition},
           ${draft.sentiment}, ${draft.excerpt}, ${draft.citedUrls},
           ${judged.parserUsed}, ${draft.confidence}, ${draft.needsReview},
           ${judged.classifierModel}, ${judged.classifierPromptVersion})
      `;
      out.inserted += 1;
      if (draft.recommended) out.recommended += 1;
    }
  }
  return out;
}
