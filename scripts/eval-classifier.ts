/**
 * Live gold-set evaluation of the production mention classifier (spec 050).
 *
 *   npx tsx scripts/eval-classifier.ts
 *
 * Runs the versioned gold corpus through classifyResponseLlm with the REAL
 * model (needs OPENAI_API_KEY; costs a few cents), persists a
 * classifier_evaluations row, prints the scorecard, and exits non-zero
 * below any floor. Run it before shipping a classifier prompt or model
 * change — the pinned-hash test forces the version bump; this proves the
 * new instrument.
 */
import * as dotenv from "dotenv";
dotenv.config();

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is not set — the live eval needs the real classifier.");
    process.exit(2);
  }
  const { evaluateClassifier, CLASSIFIER_EVAL_FLOORS } = await import(
    "@/lib/accuracy/classifier-eval"
  );
  const { sql } = await import("@/db/client");

  const result = await evaluateClassifier({ mode: "live" });

  const fmt = (v: number | null) => (v === null ? "n/a" : v.toFixed(3));
  console.log(`\nClassifier gold-set evaluation (${result.mode})`);
  console.log(`  gold set:   ${result.goldSetVersion} (${result.casesTotal} cases, ${result.pairsTotal} pairs)`);
  console.log(`  instrument: ${result.classifierPromptVersion} @ ${result.classifierModel}`);
  console.log(`  mentioned    P ${fmt(result.precisionMentioned)} (floor ${CLASSIFIER_EVAL_FLOORS.precisionMentioned})  R ${fmt(result.recallMentioned)} (floor ${CLASSIFIER_EVAL_FLOORS.recallMentioned})`);
  console.log(`  recommended  P ${fmt(result.precisionRecommended)} (floor ${CLASSIFIER_EVAL_FLOORS.precisionRecommended})  R ${fmt(result.recallRecommended)} (floor ${CLASSIFIER_EVAL_FLOORS.recallRecommended})`);
  console.log(`  entity rejection ${fmt(result.entityRejectionAccuracy)} (floor ${CLASSIFIER_EVAL_FLOORS.entityRejectionAccuracy})`);
  if (result.failures.length > 0) {
    console.log(`  failures (${result.failures.length}):`);
    for (const f of result.failures) {
      console.log(`    - [${f.caseId}] ${f.companyId} ${f.field}: expected ${f.expected}, got ${f.actual}`);
    }
  }
  console.log(result.passed ? "\nPASSED — instrument meets every floor." : "\nFAILED — do not ship this instrument.");
  await sql.end();
  process.exit(result.passed ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
