/**
 * Gold-set evaluation harness for the PRODUCTION mention classifier
 * (spec 050). Runs every gold case through classifyResponseLlm — the code
 * path that writes real mentions — and scores the results with pure math.
 *
 * Two modes share one pipeline:
 * - "live"  (scripts/eval-classifier.ts): the real model judges the corpus.
 *   Run this before shipping any classifier prompt/model change; the
 *   pinned-hash test forces the version bump, this proves the new version.
 * - "stub"  (CI): an injected caller exercises the harness and the metric
 *   math deterministically, with no network and no key.
 *
 * Every evaluation persists to classifier_evaluations (insert-only), so
 * accuracy is comparable across instrument versions instead of vanishing
 * into a terminal.
 */
import { sql } from "@/db/client";
import type { AgentCaller } from "@/lib/ai/agent";
import { modelForTask } from "@/lib/ai/routing";
import {
  classifyResponseLlm,
  MENTION_CLASSIFIER_V2,
} from "@/lib/parsing/classify-llm";
import {
  CLASSIFIER_GOLD_CASES,
  CLASSIFIER_GOLD_VERSION,
  type GoldCase,
} from "@/lib/accuracy/classifier-gold";
import { log } from "@/lib/logger";

/** Merge-blocking floors. Below any of these, the instrument does not ship. */
export const CLASSIFIER_EVAL_FLOORS = {
  precisionMentioned: 0.9,
  recallMentioned: 0.85,
  precisionRecommended: 0.85,
  recallRecommended: 0.8,
  entityRejectionAccuracy: 0.9,
} as const;

export interface EvalFailure {
  caseId: string;
  companyId: string;
  field: "mentioned" | "recommended";
  expected: boolean;
  actual: boolean;
}

export interface ClassifierEvalResult {
  goldSetVersion: string;
  classifierPromptVersion: string;
  classifierModel: string;
  mode: "live" | "stub";
  casesTotal: number;
  pairsTotal: number;
  precisionMentioned: number | null;
  recallMentioned: number | null;
  precisionRecommended: number | null;
  recallRecommended: number | null;
  entityRejectionAccuracy: number | null;
  failures: EvalFailure[];
  passed: boolean;
}

const ratio = (num: number, den: number): number | null =>
  den === 0 ? null : Number((num / den).toFixed(4));

const meets = (value: number | null, floor: number): boolean =>
  value !== null && value >= floor;

export async function evaluateClassifier(args: {
  mode: "live" | "stub";
  caller?: AgentCaller;
  cases?: GoldCase[];
}): Promise<ClassifierEvalResult> {
  const cases = args.cases ?? CLASSIFIER_GOLD_CASES;

  let mentionTp = 0;
  let mentionFp = 0;
  let mentionFn = 0;
  let recTp = 0;
  let recFp = 0;
  let recFn = 0;
  let traps = 0;
  let trapsRejected = 0;
  let pairs = 0;
  const failures: EvalFailure[] = [];

  for (const goldCase of cases) {
    const drafts = await classifyResponseLlm({
      responseText: goldCase.responseText,
      promptText: goldCase.promptText,
      companies: goldCase.companies,
      identityContext: {},
      caller: args.caller,
    });
    const byCompany = new Map(drafts.map((d) => [d.companyId, d]));

    for (const expected of goldCase.expected) {
      pairs += 1;
      const draft = byCompany.get(expected.companyId);
      const actualMentioned = draft?.mentioned === true;
      const actualRecommended = draft?.recommended === true;

      if (expected.mentioned && actualMentioned) mentionTp += 1;
      if (!expected.mentioned && actualMentioned) mentionFp += 1;
      if (expected.mentioned && !actualMentioned) mentionFn += 1;
      if (expected.recommended && actualRecommended) recTp += 1;
      if (!expected.recommended && actualRecommended) recFp += 1;
      if (expected.recommended && !actualRecommended) recFn += 1;
      if (expected.trap) {
        traps += 1;
        if (!actualMentioned) trapsRejected += 1;
      }
      if (actualMentioned !== expected.mentioned) {
        failures.push({
          caseId: goldCase.id,
          companyId: expected.companyId,
          field: "mentioned",
          expected: expected.mentioned,
          actual: actualMentioned,
        });
      }
      if (actualRecommended !== expected.recommended) {
        failures.push({
          caseId: goldCase.id,
          companyId: expected.companyId,
          field: "recommended",
          expected: expected.recommended,
          actual: actualRecommended,
        });
      }
    }
  }

  const result: ClassifierEvalResult = {
    goldSetVersion: CLASSIFIER_GOLD_VERSION,
    classifierPromptVersion: MENTION_CLASSIFIER_V2,
    classifierModel: modelForTask("mention_classification"),
    mode: args.mode,
    casesTotal: cases.length,
    pairsTotal: pairs,
    precisionMentioned: ratio(mentionTp, mentionTp + mentionFp),
    recallMentioned: ratio(mentionTp, mentionTp + mentionFn),
    precisionRecommended: ratio(recTp, recTp + recFp),
    recallRecommended: ratio(recTp, recTp + recFn),
    entityRejectionAccuracy: ratio(trapsRejected, traps),
    failures,
    passed: false,
  };
  result.passed =
    meets(result.precisionMentioned, CLASSIFIER_EVAL_FLOORS.precisionMentioned) &&
    meets(result.recallMentioned, CLASSIFIER_EVAL_FLOORS.recallMentioned) &&
    meets(result.precisionRecommended, CLASSIFIER_EVAL_FLOORS.precisionRecommended) &&
    meets(result.recallRecommended, CLASSIFIER_EVAL_FLOORS.recallRecommended) &&
    meets(result.entityRejectionAccuracy, CLASSIFIER_EVAL_FLOORS.entityRejectionAccuracy);

  await sql`
    insert into classifier_evaluations
      (gold_set_version, classifier_prompt_version, classifier_model,
       cases_total, pairs_total, precision_mentioned, recall_mentioned,
       precision_recommended, recall_recommended, entity_rejection_accuracy,
       passed, failures, mode)
    values
      (${result.goldSetVersion}, ${result.classifierPromptVersion},
       ${result.classifierModel}, ${result.casesTotal}, ${result.pairsTotal},
       ${result.precisionMentioned}, ${result.recallMentioned},
       ${result.precisionRecommended}, ${result.recallRecommended},
       ${result.entityRejectionAccuracy}, ${result.passed},
       ${sql.json(result.failures as never)}, ${result.mode})
  `;
  log("info", "classifier_eval.recorded", {
    mode: result.mode,
    passed: result.passed,
    failures: result.failures.length,
  });
  return result;
}
