/**
 * External source discovery (spec 027).
 *
 * Finds pages on the open web that carry facts about a client, captures each
 * one as an immutable artifact, and hands it to the existing claim-extraction
 * pipeline. This module owns only the step that did not exist — *which URLs
 * are worth fetching*. Everything after the URL is existing code called in
 * order (`ingestSource` → `extractClaimsFromSource`).
 *
 * The load-bearing rule: **a search result is a lead, never evidence.** No
 * claim may cite a search snippet. A page that cannot be fetched and stored
 * produces no claim, however promising it looked in the result set. That is
 * what keeps every proposed claim traceable to bytes we hold and hashed.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { writeAudit } from "@/db/audit";
import { getProvider } from "@/lib/ai/registry";
import { costMicroUsd } from "@/lib/ai/pricing";
import { extractCitations } from "@/lib/ai/citations";
import type { AgentCaller } from "@/lib/ai/agent";
import { ingestSource } from "@/lib/knowledge/sources/ingest";
import { extractClaimsFromSource } from "@/lib/knowledge/extraction/claims";
import { normalizeUrl } from "@/lib/knowledge/normalize";
import {
  buildDiscoveryQueries,
  discoveryPrompt,
  DISCOVERY_TEMPLATE_KEY,
  type DiscoveryIdentity,
  type DiscoveryQuery,
} from "@/lib/knowledge/discovery/queries";
import {
  screenAll,
  SKIP_REASON_LABEL,
  type RawCandidate,
  type ScreenedCandidate,
  type SkipReason,
} from "@/lib/knowledge/discovery/filter";
import { isFetchAllowed, type RobotsRules } from "@/lib/knowledge/discovery/robots";

/**
 * The search instrument.
 *
 * A `+search` model id, because a searched answer is a different instrument
 * from a parametric one (docs/07) — and only the searched one returns the
 * `url_citation` annotations this feature is built on. OpenAI is the only
 * provider whose search path has been verified live (DECISIONS, 2026-07-28).
 */
export const DISCOVERY_PROVIDER = "openai";
export const DISCOVERY_SEARCH_MODEL = "gpt-5.4-mini-2026-03-17+search";

/** Pages ingested per run. Each one costs a fetch, an extraction and an agent call. */
const DEFAULT_MAX_PAGES = 15;
/** Politeness gap between fetches, matching discover.ts. */
const FETCH_DELAY_MS = 1_200;
/** Default ceiling for one run, in micro-dollars. */
const DEFAULT_COST_CAP_MICRO_USD = 3_000_000;

export type SearchCaller = (args: {
  model: string;
  promptText: string;
}) => Promise<{ rawPayload: unknown; costMicroUsd: number }>;

const inputSchema = z.object({
  projectId: z.string().uuid(),
  /** Optional identity overrides; anything omitted is derived from stored records. */
  markets: z.array(z.string().min(1).max(80)).max(10).optional(),
  principals: z.array(z.string().min(1).max(120)).max(5).optional(),
  affiliation: z.string().min(1).max(120).optional(),
  maxPages: z.number().int().min(1).max(50).optional(),
  costCapMicroUsd: z.number().int().min(100_000).optional(),
});

export interface DiscoverySummary {
  discoveryRunId: string;
  status: "completed" | "partial" | "safely_stopped" | "failed";
  queries: DiscoveryQuery[];
  candidatesFound: number;
  candidatesIngested: number;
  /** Skip counts by reason, so a summary never flattens distinct outcomes. */
  skipped: Record<string, number>;
  claimsProposed: number;
  contradictionsRaised: number;
  costMicroUsd: number;
  stopReason: string | null;
  /** Prose the operator reads. Distinguishes "found nothing" from "could not fetch". */
  narrative: string;
}

/** Run discovery for one client. */
export async function runExternalDiscovery(
  user: CurrentUser,
  raw: unknown,
  options: {
    searchCaller?: SearchCaller;
    agentCaller?: AgentCaller;
    fetchImpl?: typeof fetch;
    /** Injected in tests so a suite never sleeps for politeness. */
    delayMs?: number;
  } = {}
): Promise<ActionResult<DiscoverySummary>> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid discovery request."));
  }
  const input = parsed.data;
  const maxPages = input.maxPages ?? DEFAULT_MAX_PAGES;
  const costCap = input.costCapMicroUsd ?? DEFAULT_COST_CAP_MICRO_USD;

  try {
    assertCanWrite(user);
    const identity = await loadIdentity(input.projectId, {
      markets: input.markets,
      principals: input.principals,
      affiliation: input.affiliation,
    });
    const queries = buildDiscoveryQueries(identity);
    if (queries.length === 0) {
      throw new ClassifiedError(
        "conflict",
        "No searchable identity for this client — set a subject company first."
      );
    }

    const runId = await openRun(user, input.projectId, queries, costCap);
    const state: RunState = {
      cost: 0,
      costCap,
      claimsProposed: 0,
      contradictions: 0,
      skipped: {},
      ingested: 0,
      found: 0,
      stopReason: null,
    };

    const alreadyIngested = await loadIngestedUrls(input.projectId);
    const seenInRun = new Set<string>();
    const robotsCache = new Map<string, RobotsRules>();
    // The client, its aliases, and its named people — everything a claim on a
    // third-party page may legitimately be about.
    const subjectAllowList = [
      identity.name,
      ...(identity.aliases ?? []),
      ...(identity.principals ?? []),
    ];

    for (const query of queries) {
      if (state.stopReason) break;
      const candidates = await runSearch(query, identity, state, options);
      state.found += candidates.length;

      const screened = screenAll(candidates, {
        ownDomain: identity.domain,
        alreadyIngested,
        seenInRun,
        maxPages,
        keptSoFar: state.ingested,
      });

      for (const result of screened) {
        if (!result.keep) {
          await recordCandidate(runId, input.projectId, result.candidate, "skipped", {
            skipReason: result.reason,
          });
          state.skipped[result.reason] = (state.skipped[result.reason] ?? 0) + 1;
          continue;
        }
        await ingestAndExtract(user, runId, input.projectId, result.candidate, state, {
          ...options,
          robotsCache,
          alreadyIngested,
          subjectAllowList,
        });
        if (state.stopReason) break;
      }
    }

    const status: DiscoverySummary["status"] = state.stopReason
      ? "safely_stopped"
      : state.ingested === 0 && state.found > 0
        ? "partial"
        : "completed";

    await closeRun(runId, status, state);

    const summary: DiscoverySummary = {
      discoveryRunId: runId,
      status,
      queries,
      candidatesFound: state.found,
      candidatesIngested: state.ingested,
      skipped: state.skipped,
      claimsProposed: state.claimsProposed,
      contradictionsRaised: state.contradictions,
      costMicroUsd: state.cost,
      stopReason: state.stopReason,
      narrative: narrate(state, queries.length),
    };

    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "discovery.run",
        entity: "discovery_run",
        entityId: runId,
        detail: {
          queries: queries.length,
          ingested: state.ingested,
          claimsProposed: state.claimsProposed,
        },
      })
    );

    return ok(summary);
  } catch (err) {
    return fail(err);
  }
}

interface RunState {
  cost: number;
  costCap: number;
  claimsProposed: number;
  contradictions: number;
  skipped: Record<string, number>;
  ingested: number;
  found: number;
  stopReason: string | null;
}

/** One search. Returns the pages the model actually consulted, never its prose. */
async function runSearch(
  query: DiscoveryQuery,
  identity: DiscoveryIdentity,
  state: RunState,
  options: { searchCaller?: SearchCaller }
): Promise<RawCandidate[]> {
  // Checked before the spend, not after (docs/10).
  if (state.cost >= state.costCap) {
    state.stopReason = "cost cap reached before completing the query list";
    return [];
  }

  const promptText = discoveryPrompt(query.text, identity.domain);
  try {
    const result = options.searchCaller
      ? await options.searchCaller({ model: DISCOVERY_SEARCH_MODEL, promptText })
      : await liveSearch(promptText);
    state.cost += result.costMicroUsd;

    return extractCitations(DISCOVERY_PROVIDER, result.rawPayload).map((c) => ({
      url: c.url,
      title: c.title,
      sourceQuery: query.text,
    }));
  } catch (err) {
    // One failed search is not a failed run: the remaining queries may still
    // surface pages, and the summary reports how many searches ran.
    log("warn", "discovery.search_failed", {
      query: query.text,
      reason: err instanceof Error ? err.message : "unknown",
    });
    return [];
  }
}

async function liveSearch(
  promptText: string
): Promise<{ rawPayload: unknown; costMicroUsd: number }> {
  const provider = getProvider(DISCOVERY_PROVIDER);
  const res = await provider.runPrompt({
    model: DISCOVERY_SEARCH_MODEL,
    promptText,
  });
  // Token cost only. OpenAI bills the web_search tool per call *outside* token
  // usage (DECISIONS, 2026-07-28), so the true spend is higher than this figure
  // and the cost cap is correspondingly optimistic. Understating it here is
  // better than inventing a per-call price we have not verified — but it means
  // the cap is a floor on spend, not a ceiling, until +search pricing is
  // confirmed against a real invoice.
  return {
    rawPayload: res.rawPayload,
    costMicroUsd: costMicroUsd(DISCOVERY_SEARCH_MODEL, res.tokensIn, res.tokensOut),
  };
}

/** Fetch, store, and extract claims from one surviving candidate. */
async function ingestAndExtract(
  user: CurrentUser,
  runId: string,
  projectId: string,
  candidate: ScreenedCandidate,
  state: RunState,
  options: {
    agentCaller?: AgentCaller;
    fetchImpl?: typeof fetch;
    delayMs?: number;
    robotsCache: Map<string, RobotsRules>;
    alreadyIngested: Set<string>;
    subjectAllowList: string[];
  }
): Promise<void> {
  const allowed = await isFetchAllowed(
    candidate.normalizedUrl,
    options.robotsCache,
    options.fetchImpl
  );
  if (!allowed) {
    await recordCandidate(runId, projectId, candidate, "skipped", {
      skipReason: "robots_disallowed",
    });
    state.skipped.robots_disallowed = (state.skipped.robots_disallowed ?? 0) + 1;
    return;
  }

  await pause(options.delayMs ?? FETCH_DELAY_MS);

  const ingested = await ingestSource(user, {
    projectId,
    url: candidate.normalizedUrl,
    origin: "url_fetch",
    sourceType: "website",
    // Publicly retrievable pages are public; retention still follows the
    // client's class, which ingestSource applies.
    privacy: "public",
  });

  if (!ingested.ok) {
    await recordCandidate(runId, projectId, candidate, "skipped", {
      skipReason: "fetch_failed",
    });
    state.skipped.fetch_failed = (state.skipped.fetch_failed ?? 0) + 1;
    return;
  }

  if (ingested.data.extractedTextLength === 0) {
    // Stored but unusable — the artifact stays (we paid for the bytes and they
    // are evidence of what the page served), the claim step is skipped.
    await recordCandidate(runId, projectId, candidate, "skipped", {
      skipReason: "empty_extraction",
      sourceArtifactId: ingested.data.sourceArtifactId,
    });
    state.skipped.empty_extraction = (state.skipped.empty_extraction ?? 0) + 1;
    return;
  }

  await recordCandidate(runId, projectId, candidate, "ingested", {
    sourceArtifactId: ingested.data.sourceArtifactId,
  });
  state.ingested += 1;
  options.alreadyIngested.add(candidate.normalizedUrl);

  if (state.cost >= state.costCap) {
    state.stopReason = "cost cap reached before extracting claims from every page";
    return;
  }

  const extracted = await extractClaimsFromSource(
    user,
    {
      sourceArtifactId: ingested.data.sourceArtifactId,
      // A third-party page is mostly not about this client. Without this, an
      // article mentioning them once contributes twenty claims about other
      // businesses — 91 proposals from five pages on the first live run, which
      // is a review queue nobody works through.
      subjectAllowList: options.subjectAllowList,
    },
    { caller: options.agentCaller }
  );
  if (!extracted.ok) {
    log("warn", "discovery.extraction_failed", {
      url: candidate.normalizedUrl,
      reason: extracted.error.message,
    });
    return;
  }
  state.claimsProposed += extracted.data.proposed.length;
  state.contradictions += extracted.data.contradictionsDetected;
  state.cost += extracted.data.costMicroUsd;
}

async function loadIdentity(
  projectId: string,
  overrides: {
    markets?: string[];
    principals?: string[];
    affiliation?: string;
  }
): Promise<DiscoveryIdentity> {
  const [row] = await sql`
    select p.id, c.name, c.aliases, c.domain
    from projects p
    left join companies c on c.id = p.subject_company_id
    where p.id = ${projectId}
  `;
  if (!row) throw new ClassifiedError("not_found", "Client not found.");
  if (!row.name) {
    throw new ClassifiedError(
      "conflict",
      "This client has no subject company, so there is nothing to search for."
    );
  }

  // Principals come from recorded entities rather than from parsing claim
  // prose: an entity row is something a human already accepted as a person.
  const principals =
    overrides.principals ??
    (
      await sql`
        select canonical_name from knowledge_entities
        where project_id = ${projectId} and entity_type = 'person'
          and status = 'active'
        order by created_at limit 2
      `
    ).map((r) => r.canonicalName as string);

  return {
    name: row.name as string,
    aliases: (row.aliases as string[] | null) ?? [],
    domain: (row.domain as string | null) ?? undefined,
    principals,
    markets: overrides.markets ?? [],
    affiliation: overrides.affiliation,
  };
}

/** Normalized URLs already held for this client, so a re-run ingests nothing twice. */
async function loadIngestedUrls(projectId: string): Promise<Set<string>> {
  const rows = await sql`
    select original_url from source_artifacts
    where project_id = ${projectId} and original_url is not null
  `;
  return new Set(rows.map((r) => normalizeUrl(r.originalUrl as string)));
}

async function openRun(
  user: CurrentUser,
  projectId: string,
  queries: DiscoveryQuery[],
  costCap: number
): Promise<string> {
  const [row] = await sql`
    insert into discovery_runs
      (project_id, queries, template_key, provider, model, cost_cap_micro_usd, started_by)
    values (${projectId}, ${sql.json(queries as never)}, ${DISCOVERY_TEMPLATE_KEY},
      ${DISCOVERY_PROVIDER}, ${DISCOVERY_SEARCH_MODEL}, ${costCap}, ${user.id})
    returning id
  `;
  if (!row) throw new ClassifiedError("internal", "Could not open a discovery run.");
  return row.id as string;
}

async function closeRun(
  runId: string,
  status: DiscoverySummary["status"],
  state: RunState
): Promise<void> {
  await sql`
    update discovery_runs set
      status = ${status},
      candidates_found = ${state.found},
      candidates_ingested = ${state.ingested},
      candidates_skipped = ${Object.values(state.skipped).reduce((a, b) => a + b, 0)},
      claims_proposed = ${state.claimsProposed},
      contradictions_raised = ${state.contradictions},
      cost_micro_usd = ${state.cost},
      stop_reason = ${state.stopReason},
      completed_at = now()
    where id = ${runId}
  `;
}

async function recordCandidate(
  runId: string,
  projectId: string,
  candidate: ScreenedCandidate,
  decision: "ingested" | "skipped",
  extra: { skipReason?: SkipReason; sourceArtifactId?: string }
): Promise<void> {
  // A skip that also produced an artifact (empty extraction) still records the
  // artifact: we hold those bytes, and pretending otherwise would leave an
  // untraceable row in source_artifacts.
  await sql`
    insert into discovery_candidates
      (discovery_run_id, project_id, url, normalized_url, title, source_query,
       decision, skip_reason, source_artifact_id)
    values (${runId}, ${projectId}, ${candidate.url}, ${candidate.normalizedUrl},
      ${candidate.title}, ${candidate.sourceQuery}, ${decision},
      ${extra.skipReason ?? null}, ${extra.sourceArtifactId ?? null})
  `;
}

/**
 * The sentence an operator reads.
 *
 * Written to make the difference between "nothing is out there" and "plenty is
 * out there and we could not read it" impossible to miss — they imply opposite
 * next actions.
 */
export function narrate(state: RunState, queryCount: number): string {
  if (state.found === 0) {
    return `${queryCount} searches returned no pages. Either this client has no external footprint, or the queries are wrong — check the query list before concluding the former.`;
  }
  const parts = [
    `${queryCount} searches surfaced ${state.found} pages; ${state.ingested} were captured.`,
  ];
  const skips = Object.entries(state.skipped)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${SKIP_REASON_LABEL[reason as SkipReason] ?? reason}`);
  if (skips.length > 0) parts.push(`Skipped: ${skips.join("; ")}.`);
  parts.push(
    state.claimsProposed > 0
      ? `${state.claimsProposed} claims proposed — none are approved, and each needs a decision.`
      : `No claims were proposed from the captured pages.`
  );
  if (state.contradictions > 0) {
    parts.push(
      `${state.contradictions} contradict an approved claim and were flagged, not resolved.`
    );
  }
  if (state.stopReason) parts.push(`Stopped early: ${state.stopReason}.`);
  return parts.join(" ");
}

function pause(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
