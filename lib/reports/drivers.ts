/**
 * Visibility change drivers (spec 087, P1): when the subject's visibility
 * moved between two comparable runs, which observable dimensions moved with
 * it — providers, prompt clusters, newly cited domains, newly recommended
 * rivals — and which interventions shipped in between.
 *
 * Strictly associative. Every sentence this module produces must survive
 * findCausalPhrase (lib/workflow/gates.ts): "observed following",
 * "occurred before the later measurement" — never "caused by". Attribution
 * with a linked intervention stays in lib/attribution/verdict.ts.
 *
 * Derived on read from the immutable ledgers; comparable means the same
 * frozen prompt-set version (the reports/snapshot rule).
 */
import type { FrozenPrompt } from "@/lib/prompts/types";
import type { RunMentionRow, ValidResponseRow } from "@/db/displacement";
import {
  promptContexts,
  type PromptContext,
} from "@/lib/competitors/displacement";

export const CHANGE_DRIVERS_VERSION = "change-drivers-v1";

/** A one-response wiggle is noise; a driver needs at least this much delta. */
export const DRIVER_MIN_DELTA = 2;

export interface DriverRow {
  segment: string;
  previous: number;
  current: number;
  delta: number;
}

export interface ChangeDrivers {
  version: string;
  status: "ok" | "not_comparable";
  previousRunId: string;
  currentRunId: string;
  /** Subject recommendation moments (echo-excluded responses) per side. */
  previousRecommended: number;
  currentRecommended: number;
  byProvider: DriverRow[];
  byCluster: DriverRow[];
  /** Domains cited in the current run and never in the previous one. */
  newDomains: string[];
  /** Rivals recommended (echo-excluded) now but not before. */
  newRivals: string[];
  /** Interventions shipped between the two measurements — listed, not
   * credited. */
  interventionsBetween: { id: string; title: string; shippedAt: string }[];
  observations: string[];
}

interface RunSide {
  responses: ValidResponseRow[];
  mentions: RunMentionRow[];
}

function subjectRecommendedResponses(
  side: RunSide,
  subjectCompanyId: string,
  contexts: Map<string, PromptContext>
): Set<string> {
  const eligible = new Set(
    side.responses
      .filter((r) => !(contexts.get(r.promptId)?.isHoldout ?? false))
      .map((r) => r.id)
  );
  const out = new Set<string>();
  for (const m of side.mentions) {
    if (!eligible.has(m.responseId)) continue;
    if (m.companyId !== subjectCompanyId) continue;
    if (!m.mentioned || !m.recommended || m.promptEchoed) continue;
    out.add(m.responseId);
  }
  return out;
}

function tallyBy(
  ids: Set<string>,
  segmentOf: (responseId: string) => string | null
): Map<string, number> {
  const out = new Map<string, number>();
  for (const id of ids) {
    const segment = segmentOf(id);
    if (segment == null) continue;
    out.set(segment, (out.get(segment) ?? 0) + 1);
  }
  return out;
}

function diffRows(
  previous: Map<string, number>,
  current: Map<string, number>
): DriverRow[] {
  const segments = new Set([...previous.keys(), ...current.keys()]);
  return [...segments]
    .map((segment) => {
      const prev = previous.get(segment) ?? 0;
      const curr = current.get(segment) ?? 0;
      return { segment, previous: prev, current: curr, delta: curr - prev };
    })
    .filter((row) => Math.abs(row.delta) >= DRIVER_MIN_DELTA)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.segment.localeCompare(b.segment));
}

/** Pure decomposition over two runs' valid responses + current mentions
 * sharing one frozen snapshot. */
export function computeChangeDrivers(input: {
  previousRunId: string;
  currentRunId: string;
  subjectCompanyId: string;
  frozenPrompts: FrozenPrompt[];
  previous: RunSide;
  current: RunSide;
  previousDomains: Set<string>;
  currentDomains: Set<string>;
  interventionsBetween: { id: string; title: string; shippedAt: string }[];
}): ChangeDrivers {
  const contexts = promptContexts(input.frozenPrompts);
  const prevRec = subjectRecommendedResponses(
    input.previous,
    input.subjectCompanyId,
    contexts
  );
  const currRec = subjectRecommendedResponses(
    input.current,
    input.subjectCompanyId,
    contexts
  );

  const providerOf = (side: RunSide) => {
    const byId = new Map(side.responses.map((r) => [r.id, r.provider]));
    return (id: string) => byId.get(id) ?? null;
  };
  const clusterOf = (side: RunSide) => {
    const byId = new Map(side.responses.map((r) => [r.id, r.promptId]));
    return (id: string) => {
      const promptId = byId.get(id);
      return promptId ? (contexts.get(promptId)?.clusterLabel ?? null) : null;
    };
  };

  const byProvider = diffRows(
    tallyBy(prevRec, providerOf(input.previous)),
    tallyBy(currRec, providerOf(input.current))
  );
  const byCluster = diffRows(
    tallyBy(prevRec, clusterOf(input.previous)),
    tallyBy(currRec, clusterOf(input.current))
  );

  const rivalNames = (side: RunSide): Set<string> => {
    const eligible = new Set(side.responses.map((r) => r.id));
    const out = new Set<string>();
    for (const m of side.mentions) {
      if (!eligible.has(m.responseId)) continue;
      if (m.companyId === input.subjectCompanyId) continue;
      if (!m.mentioned || !m.recommended || m.promptEchoed) continue;
      out.add(m.companyName);
    }
    return out;
  };
  const prevRivals = rivalNames(input.previous);
  const newRivals = [...rivalNames(input.current)]
    .filter((name) => !prevRivals.has(name))
    .sort();

  const newDomains = [...input.currentDomains]
    .filter((d) => !input.previousDomains.has(d))
    .sort();

  const delta = currRec.size - prevRec.size;
  const observations = [
    `Subject recommendation moments moved from ${prevRec.size} to ` +
      `${currRec.size} (${delta >= 0 ? "+" : ""}${delta}) between the two runs.`,
    ...byProvider
      .slice(0, 3)
      .map(
        (row) =>
          `${row.segment}: ${row.previous} → ${row.current} recommendation ` +
          `moments in the later run.`
      ),
    ...byCluster
      .slice(0, 3)
      .map(
        (row) =>
          `Cluster "${row.segment}": ${row.previous} → ${row.current} ` +
          `recommendation moments in the later run.`
      ),
    ...(newDomains.length > 0
      ? [`Newly observed cited domains: ${newDomains.slice(0, 5).join(", ")}.`]
      : []),
    ...(newRivals.length > 0
      ? [`Newly recommended rivals: ${newRivals.slice(0, 5).join(", ")}.`]
      : []),
    ...input.interventionsBetween.map(
      (i) =>
        `Intervention "${i.title}" shipped ${i.shippedAt} — before the ` +
        `later measurement; listed for context, not credited.`
    ),
  ];

  return {
    version: CHANGE_DRIVERS_VERSION,
    status: "ok",
    previousRunId: input.previousRunId,
    currentRunId: input.currentRunId,
    previousRecommended: prevRec.size,
    currentRecommended: currRec.size,
    byProvider,
    byCluster,
    newDomains,
    newRivals,
    interventionsBetween: input.interventionsBetween,
    observations,
  };
}

/**
 * Drivers between two runs of one project. Not comparable (different frozen
 * prompt-set versions) → status 'not_comparable', no decomposition —
 * comparing different questionnaires explains nothing. Null when either run
 * is missing.
 */
export async function runChangeDrivers(
  previousRunId: string,
  currentRunId: string,
  options: { subjectCompanyId?: string } = {}
): Promise<ChangeDrivers | null> {
  const { sql } = await import("@/db/client");
  const { getSubjectCompany } = await import("@/db/companies");
  const {
    validResponsesForRun,
    currentMentionsWithEcho,
    citationDomainsForResponses,
  } = await import("@/db/displacement");
  const { mockScoringAllowed } = await import("@/lib/ai/registry");

  const runs = await sql`
    select r.id, r.project_id, r.prompt_set_version_id, r.started_at,
      r.completed_at, v.frozen_prompts
    from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.id in (${previousRunId}, ${currentRunId})
  `;
  const previous = runs.find((r) => r.id === previousRunId);
  const current = runs.find((r) => r.id === currentRunId);
  if (!previous || !current) return null;
  if (previous.promptSetVersionId !== current.promptSetVersionId) {
    return {
      version: CHANGE_DRIVERS_VERSION,
      status: "not_comparable",
      previousRunId,
      currentRunId,
      previousRecommended: 0,
      currentRecommended: 0,
      byProvider: [],
      byCluster: [],
      newDomains: [],
      newRivals: [],
      interventionsBetween: [],
      observations: [
        "The runs froze different prompt-set versions — deltas between " +
          "different questionnaires are not decomposable.",
      ],
    };
  }

  let subjectCompanyId = options.subjectCompanyId;
  if (!subjectCompanyId) {
    const subject = await getSubjectCompany(current.projectId as string);
    if (!subject) return null;
    subjectCompanyId = subject.id;
  }

  const loadSide = async (runId: string): Promise<RunSide> => {
    const all = await validResponsesForRun(runId);
    const responses = mockScoringAllowed()
      ? all
      : all.filter((r) => r.provider !== "mock");
    const ids = new Set(responses.map((r) => r.id));
    const mentions = (await currentMentionsWithEcho(runId)).filter((m) =>
      ids.has(m.responseId)
    );
    return { responses, mentions };
  };
  const [prevSide, currSide] = await Promise.all([
    loadSide(previousRunId),
    loadSide(currentRunId),
  ]);

  const domainsOf = async (side: RunSide): Promise<Set<string>> =>
    new Set(
      (
        await citationDomainsForResponses(side.responses.map((r) => r.id))
      ).map((r) => r.domain)
    );
  const [previousDomains, currentDomains] = await Promise.all([
    domainsOf(prevSide),
    domainsOf(currSide),
  ]);

  const interventionsBetween = await sql`
    select id, title, shipped_at
    from interventions
    where project_id = ${current.projectId}
      and archived_at is null
      and shipped_at >= coalesce(${previous.completedAt}, ${previous.startedAt})::date
      and shipped_at <= coalesce(${current.completedAt}, now())::date
    order by shipped_at asc
  `;

  return computeChangeDrivers({
    previousRunId,
    currentRunId,
    subjectCompanyId,
    frozenPrompts: current.frozenPrompts as FrozenPrompt[],
    previous: prevSide,
    current: currSide,
    previousDomains,
    currentDomains,
    interventionsBetween: interventionsBetween.map((i) => ({
      id: i.id as string,
      title: i.title as string,
      shippedAt: String(i.shippedAt),
    })),
  });
}
