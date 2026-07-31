/**
 * Retrieval evaluation (spec 025).
 *
 * Follows the `tests/unit/parser-accuracy.test.ts` precedent: fixtures assert
 * a scored floor, not a boolean, because a regression is a number moving and
 * you cannot see movement in a pass/fail.
 *
 * The asymmetry between the two gates is deliberate and load-bearing:
 *
 *   - **Recall** of required facts is a *ratio* with a floor. A packet missing
 *     one supporting example is degraded, not dangerous.
 *   - **Forbidden** items are a *count* with zero tolerance. One stale claim,
 *     one restricted source, or one other client's fact reaching an agent is a
 *     breach — averaging that against successes would let a leak hide behind a
 *     good score.
 */
import { sql } from "@/db/client";
import {
  RETRIEVAL_FORBIDDEN_TOLERANCE,
  RETRIEVAL_RECALL_FLOOR,
} from "@/lib/knowledge/constants";
import type { ContextPacket } from "@/lib/knowledge/context/builder";

export interface RetrievalFixture {
  key: string;
  taskType: string;
  description: string;
  /** Substrings or claim keys the packet MUST carry. */
  required: string[];
  /** Substrings that must NOT appear anywhere in the rendered packet. */
  forbidden: string[];
  tokenBudget?: number;
}

export interface FixtureScore {
  fixtureKey: string;
  taskType: string;
  requiredTotal: number;
  requiredFound: number;
  forbiddenTotal: number;
  forbiddenPresent: number;
  recall: number | null;
  tokenCount: number;
  tokenBudget: number | null;
  passed: boolean;
  failures: string[];
}

/**
 * Score one packet against one fixture.
 *
 * Matching is case-insensitive substring over the rendered packet plus its
 * structured items. Rendering is what the agent actually receives, so a fact
 * present in the data but absent from the rendering is genuinely missing.
 */
export function scoreFixture(
  fixture: RetrievalFixture,
  packet: ContextPacket,
  rendered: string
): FixtureScore {
  const haystack = [
    rendered,
    ...packet.items.filter((i) => i.included).map((i) => `${i.label} ${i.itemRef}`),
  ]
    .join("\n")
    .toLowerCase();

  const missing = fixture.required.filter((r) => !haystack.includes(r.toLowerCase()));
  const leaked = fixture.forbidden.filter((f) => haystack.includes(f.toLowerCase()));

  const requiredFound = fixture.required.length - missing.length;
  const recall =
    fixture.required.length === 0 ? null : requiredFound / fixture.required.length;

  const failures: string[] = [];
  for (const item of missing) failures.push(`missing required: "${item}"`);
  for (const item of leaked) failures.push(`FORBIDDEN present: "${item}"`);

  const overBudget =
    fixture.tokenBudget !== undefined && packet.tokenCount > fixture.tokenBudget;
  if (overBudget) {
    failures.push(`token budget exceeded: ${packet.tokenCount} > ${fixture.tokenBudget}`);
  }

  const passed =
    leaked.length <= RETRIEVAL_FORBIDDEN_TOLERANCE &&
    (recall === null || recall >= RETRIEVAL_RECALL_FLOOR) &&
    !overBudget;

  return {
    fixtureKey: fixture.key,
    taskType: fixture.taskType,
    requiredTotal: fixture.required.length,
    requiredFound,
    forbiddenTotal: fixture.forbidden.length,
    forbiddenPresent: leaked.length,
    recall,
    tokenCount: packet.tokenCount,
    tokenBudget: fixture.tokenBudget ?? null,
    passed,
    failures,
  };
}

/** Persist a score so regressions are visible across runs, not just in CI. */
export async function recordEvaluation(
  suite: string,
  score: FixtureScore,
  projectId: string | null,
  packetId?: string | null
): Promise<void> {
  await sql`
    insert into retrieval_evaluations (
      suite, fixture_key, task_type, project_id, required_total, required_found,
      forbidden_total, forbidden_present, recall, precision, token_count,
      token_budget, passed, failures, packet_id
    ) values (
      ${suite}, ${score.fixtureKey}, ${score.taskType}, ${projectId},
      ${score.requiredTotal}, ${score.requiredFound}, ${score.forbiddenTotal},
      ${score.forbiddenPresent}, ${score.recall},
      ${score.forbiddenTotal === 0 ? null : 1 - score.forbiddenPresent / score.forbiddenTotal},
      ${score.tokenCount}, ${score.tokenBudget}, ${score.passed},
      ${sql.json(score.failures as never)}, ${packetId ?? null}
    )
  `;
}

export interface SuiteSummary {
  suite: string;
  fixtures: number;
  passed: number;
  meanRecall: number | null;
  anyForbiddenPresent: boolean;
  failures: { fixtureKey: string; failures: string[] }[];
}

export function summarize(suite: string, scores: FixtureScore[]): SuiteSummary {
  const withRecall = scores.filter((s) => s.recall !== null);
  return {
    suite,
    fixtures: scores.length,
    passed: scores.filter((s) => s.passed).length,
    meanRecall:
      withRecall.length === 0
        ? null
        : withRecall.reduce((sum, s) => sum + (s.recall ?? 0), 0) / withRecall.length,
    anyForbiddenPresent: scores.some((s) => s.forbiddenPresent > 0),
    failures: scores
      .filter((s) => !s.passed)
      .map((s) => ({ fixtureKey: s.fixtureKey, failures: s.failures })),
  };
}
