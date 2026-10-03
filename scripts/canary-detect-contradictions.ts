/**
 * Spec 146 §11 post-promotion canary for `detect_contradictions`.
 *
 *   DATABASE_URL=<local test db> npx tsx scripts/canary-detect-contradictions.ts
 *
 * Twenty NEW profile-correction comparisons (not gold-set fixtures), each
 * labelled before any run, executed through the production path:
 *
 *   registered profileCorrectionWorkflow version (its stored `compare` node,
 *   contextPaths and agentVersion pin)
 *   → a real workflow_runs row per case, with the upstream `canonical_extract`
 *     and `approved_facts` outputs as succeeded node_runs
 *   → the registered `agt.detect_contradictions` handler (resolveAgentContext,
 *     AUTOMATION_PROMPTS routing, runAgent, the deterministic guard)
 *   → the registered `ctl.condition` handler for `has_error`.
 *
 * Nothing downstream of `has_error` runs: no drafting, no approval, no submit,
 * no external action. Writes go only to the database in DATABASE_URL, which
 * must be a local test database. Refuses to run with OPENAI_API_KEY set.
 *
 * Stops immediately on: a non-Ollama or non-qwen3:30b call, a bypassed
 * validator, a malformed answer treated as clean, an isolation failure, a
 * missed contradiction, or a false positive.
 *
 *   CANARY_OUT=<path>   also write every run as JSON
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

if (process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY must be unset for the detect_contradictions canary");
}
const DB_URL = process.env.DATABASE_URL ?? "";
if (!/_test(\?|$)/.test(DB_URL) || !/localhost|127\.0\.0\.1/.test(DB_URL)) {
  throw new Error("DATABASE_URL must point at a local *_test database");
}

type Severity = "low" | "medium" | "high" | "critical";
const IDENTITY: Severity[] = ["critical"];
const MEASURE: Severity[] = ["high", "critical"];
const DESCRIPTIVE: Severity[] = ["medium", "high"];
const STRUCTURE: Severity[] = ["medium", "high", "critical"];

const CANARY_MODEL = "qwen3:30b";
const CANARY_BACKEND = "ollama";
const AGENT_VERSION = "detect-contradictions-v2";

function uid(seed: string): string {
  const h = createHash("sha1").update(`spec146-canary:${seed}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface ObsOpts {
  subject: string;
  predicate: string;
  object?: string;
  category: string;
  asOf?: string | null;
  value?: string | number | null;
  existingStatus?: "proposed" | "approved" | "rejected" | "superseded";
  claimId?: string;
}

/** An observed claim in the `canonical_extract.claims` shape (specs 145B, 145E). */
function obs(c: string, key: string, wording: string, o: ObsOpts) {
  const base = {
    subject: o.subject,
    predicate: o.predicate,
    object: o.object ?? "",
    originalWording: wording,
    normalizedWording: wording,
    category: o.category,
    asOf: o.asOf ?? null,
    value: o.value ?? null,
    confidence: 0.9,
    locator: "",
    claimId: o.claimId ?? uid(`${c}:obs:${key}`),
    materiality: "ordinary",
    requiresIndependentVerification: false,
    subjectEntityId: null,
    excerptVerified: true,
  };
  if (!o.existingStatus) return base;
  return {
    ...base,
    existingStatus: o.existingStatus,
    resolution: o.existingStatus === "proposed" ? "linked" : "already_known",
    evidenceId: uid(`${c}:evidence:${key}`),
  };
}

interface ApprOpts {
  category: string;
  predicate?: string;
  asOf?: string | null;
  value?: unknown;
  id?: string;
}

/** An approved PacketClaim (dom.build_evidence_packet). */
function appr(c: string, key: string, text: string, o: ApprOpts) {
  return {
    id: o.id ?? uid(`${c}:appr:${key}`),
    key,
    text,
    value: o.value ?? null,
    predicate: o.predicate ?? null,
    category: o.category,
    asOf: o.asOf ?? null,
    effectiveDate: null,
    reviewDate: null,
    verificationStatus: "verified",
    confidence: 0.95,
    privacyStatus: "public",
    allowedWording: [],
    prohibitedWording: [],
    evidenceIds: [uid(`${c}:appr-ev:${key}`)],
    stale: false,
  };
}

type Obs = ReturnType<typeof obs>;
type Appr = ReturnType<typeof appr>;

function packet(c: string, claims: Appr[]) {
  return {
    packetId: uid(`${c}:packet`),
    hashesValid: true,
    artifactCount: 0,
    hashedArtifactCount: 0,
    integrityNote: "No hashed artifacts in this packet; there is nothing to verify.",
    claimCount: claims.length,
    sourceCount: claims.length,
    contradictionCount: 0,
    staleClaimCount: 0,
    requiredDisclaimers: [],
    withheldClaimCount: 0,
    sampleSize: claims.length,
    rawEvidenceCount: claims.length,
    evidenceKinds: ["source"],
    classifiedCount: claims.length,
    partialFailureCount: 0,
    partialFailureDisclosed: true,
    requiredUpstreamTotal: 1,
    requiredUpstreamCompleted: 1,
    audience: "public",
    claims,
    contradictions: [],
    evidenceIds: claims.flatMap((x) => x.evidenceIds),
  };
}

interface CanaryCase {
  id: string;
  kind: string;
  rule: string;
  observed: Obs[];
  approved: Appr[];
  expected: { obs: Obs; appr: Appr; severity: Severity[]; floorHigh?: boolean }[];
}

const ROSA = "Rosa Delgado";
const DANIEL = "Daniel Delgado";
const TEAM = "Harborline Homes Team";

function cases(): CanaryCase[] {
  const out: CanaryCase[] = [];
  const add = (x: CanaryCase) => out.push(x);

  // ------------------------------------------------ actual contradictions
  {
    const c = "c01_brokerage";
    const o = obs(c, "o1", "Rosa Delgado is a sales associate with Keller Williams Hoboken.", { subject: ROSA, predicate: "is a sales associate with", object: "Keller Williams Hoboken", category: "affiliation" });
    const o2 = obs(c, "o2", "Rosa Delgado serves Hoboken and Weehawken.", { subject: ROSA, predicate: "serves", category: "market" });
    const a = appr(c, "a1", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { category: "affiliation", predicate: "is_affiliated_with" });
    const a2 = appr(c, "a2", "Rosa Delgado serves Hoboken, Weehawken and Union City.", { category: "market", predicate: "serves" });
    add({ id: c, kind: "actual contradiction (brokerage)", rule: "exclusive relationship: brokerage", observed: [o, o2], approved: [a, a2], expected: [{ obs: o, appr: a, severity: IDENTITY, floorHigh: true }] });
  }
  {
    const c = "c02_license";
    const o = obs(c, "o1", "Rosa Delgado holds New Jersey real estate salesperson license 0458812.", { subject: ROSA, predicate: "holds license", object: "0458812", category: "licensing", value: "0458812" });
    const a = appr(c, "a1", "Rosa Delgado holds New Jersey real estate salesperson license 0451288.", { category: "licensing", predicate: "holds_license", value: "0451288" });
    add({ id: c, kind: "actual contradiction (license number)", rule: "exclusive relationship: license number", observed: [o], approved: [a], expected: [{ obs: o, appr: a, severity: IDENTITY, floorHigh: true }] });
  }
  {
    const c = "c03_count_same_year";
    const o = obs(c, "o1", "Rosa Delgado closed 27 transactions in 2025.", { subject: ROSA, predicate: "closed", object: "27 transactions", category: "transaction", value: 27 });
    const a = appr(c, "a1", "Rosa Delgado closed 31 transactions in 2025.", { category: "transaction", predicate: "closed", value: 31 });
    add({ id: c, kind: "changed value (same period)", rule: "same subject, measure and period, different quantity", observed: [o], approved: [a], expected: [{ obs: o, appr: a, severity: MEASURE }] });
  }
  {
    const c = "c04_volume_magnitude";
    const o = obs(c, "o1", "Harborline Homes Team recorded $1.9 million in sales volume in 2025.", { subject: TEAM, predicate: "recorded sales volume", category: "sales_volume", value: 1900000 });
    const a = appr(c, "a1", "Harborline Homes Team recorded $19 million in sales volume in 2025.", { category: "sales_volume", predicate: "sales_volume", value: 19000000 });
    add({ id: c, kind: "changed value (magnitude)", rule: "same subject, measure and period, different quantity", observed: [o], approved: [a], expected: [{ obs: o, appr: a, severity: MEASURE }] });
  }
  {
    const c = "c05_licensed_year";
    const o = obs(c, "o1", "Rosa Delgado has been licensed in New Jersey since 2015.", { subject: ROSA, predicate: "licensed since", object: "2015", category: "licensing" });
    const a = appr(c, "a1", "Rosa Delgado has been licensed in New Jersey since 2011.", { category: "licensing", predicate: "licensed_since" });
    add({ id: c, kind: "changed date (contradiction)", rule: "same event, different date", observed: [o], approved: [a], expected: [{ obs: o, appr: a, severity: STRUCTURE }] });
  }
  {
    const c = "c06_founded_year";
    const o = obs(c, "o1", "Harborline Homes Team was founded in 2007.", { subject: TEAM, predicate: "was founded in", object: "2007", category: "identity" });
    const o2 = obs(c, "o2", "Harborline Homes Team is based in Hoboken.", { subject: TEAM, predicate: "is based in", object: "Hoboken", category: "identity" });
    const a = appr(c, "a1", "Harborline Homes Team was founded in 2003.", { category: "identity", predicate: "founded_in" });
    const a2 = appr(c, "a2", "Harborline Homes Team is headquartered in Hoboken.", { category: "identity", predicate: "headquartered_in" });
    add({ id: c, kind: "changed date (contradiction)", rule: "same event, different date", observed: [o, o2], approved: [a, a2], expected: [{ obs: o, appr: a, severity: STRUCTURE }] });
  }
  {
    const c = "c07_rejected_recurring";
    const o = obs(c, "o1", "Rosa Delgado is an agent with RE/MAX Gold Coast.", { subject: ROSA, predicate: "is an agent with", object: "RE/MAX Gold Coast", category: "affiliation", existingStatus: "rejected" });
    const a = appr(c, "a1", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { category: "affiliation", predicate: "is_affiliated_with" });
    add({ id: c, kind: "repeated known error (rejected)", rule: "a rejected claim that disagrees is a recurring error", observed: [o], approved: [a], expected: [{ obs: o, appr: a, severity: IDENTITY, floorHigh: true }] });
  }
  {
    const c = "c08_superseded_recurring";
    const o = obs(c, "o1", "Harborline Homes Team is led by Marcus Webb.", { subject: TEAM, predicate: "is led by", object: "Marcus Webb", category: "team", existingStatus: "superseded" });
    const a = appr(c, "a1", "Harborline Homes Team is led by Rosa Delgado.", { category: "team", predicate: "led_by" });
    add({ id: c, kind: "repeated known error (superseded)", rule: "a superseded claim that disagrees is a recurring error", observed: [o], approved: [a], expected: [{ obs: o, appr: a, severity: STRUCTURE }] });
  }
  {
    const c = "c09_market_negation";
    const o = obs(c, "o1", "Rosa Delgado no longer serves Union City.", { subject: ROSA, predicate: "no longer serves", object: "Union City", category: "market" });
    const a = appr(c, "a1", "Rosa Delgado serves Hoboken, Weehawken and Union City.", { category: "market", predicate: "serves" });
    add({ id: c, kind: "actual contradiction (negation)", rule: "negation of an approved fact", observed: [o], approved: [a], expected: [{ obs: o, appr: a, severity: DESCRIPTIVE }] });
  }
  {
    const c = "c10_ranking";
    const o = obs(c, "o1", "RealTrends ranked Harborline Homes Team #22 among New Jersey teams by transaction sides in 2025.", { subject: TEAM, predicate: "was ranked", object: "#22", category: "ranking", value: 22 });
    const a = appr(c, "a1", "RealTrends ranked Harborline Homes Team #12 among New Jersey teams by transaction sides in 2025.", { category: "ranking", predicate: "ranked", value: 12 });
    add({ id: c, kind: "changed value (rank, same list and year)", rule: "different rank, same list and year", observed: [o], approved: [a], expected: [{ obs: o, appr: a, severity: MEASURE }] });
  }
  {
    const c = "c11_buried_award";
    const o1 = obs(c, "o1", "Rosa Delgado serves buyers and sellers in Hoboken.", { subject: ROSA, predicate: "serves", category: "market" });
    const o2 = obs(c, "o2", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { subject: ROSA, predicate: "is affiliated with", object: "Coldwell Banker Realty", category: "affiliation" });
    const o3 = obs(c, "o3", "Rosa Delgado earned the NJ Realtors Circle of Excellence Platinum award for 2024.", { subject: ROSA, predicate: "earned", object: "Platinum award", category: "award" });
    const o4 = obs(c, "o4", "Rosa Delgado specializes in brownstone sales.", { subject: ROSA, predicate: "specializes in", category: "specialty" });
    const a1 = appr(c, "a1", "Rosa Delgado serves Hoboken, Weehawken and Union City.", { category: "market", predicate: "serves" });
    const a2 = appr(c, "a2", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { category: "affiliation", predicate: "is_affiliated_with" });
    const a3 = appr(c, "a3", "Rosa Delgado earned the NJ Realtors Circle of Excellence Gold award for 2024.", { category: "award", predicate: "earned" });
    const a4 = appr(c, "a4", "Rosa Delgado specializes in brownstone and condominium sales.", { category: "specialty", predicate: "specializes_in" });
    add({ id: c, kind: "actual contradiction (buried, award level)", rule: "different award level, same list and year; the rest compatible", observed: [o1, o2, o3, o4], approved: [a1, a2, a3, a4], expected: [{ obs: o3, appr: a3, severity: MEASURE }] });
  }

  // ------------------------------------------------ no contradiction
  {
    const c = "c12_clean_page";
    const o1 = obs(c, "o1", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { subject: ROSA, predicate: "is affiliated with", object: "Coldwell Banker Realty", category: "affiliation" });
    const o2 = obs(c, "o2", "Rosa Delgado closed 31 transactions in 2025.", { subject: ROSA, predicate: "closed", object: "31 transactions", category: "transaction", value: 31 });
    const o3 = obs(c, "o3", "Rosa Delgado serves Hoboken, Weehawken and Union City.", { subject: ROSA, predicate: "serves", category: "market" });
    const a1 = appr(c, "a1", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { category: "affiliation", predicate: "is_affiliated_with" });
    const a2 = appr(c, "a2", "Rosa Delgado closed 31 transactions in 2025.", { category: "transaction", predicate: "closed", value: 31 });
    const a3 = appr(c, "a3", "Rosa Delgado serves Hoboken, Weehawken and Union City.", { category: "market", predicate: "serves" });
    add({ id: c, kind: "clean page", rule: "every observed claim equals an approved fact", observed: [o1, o2, o3], approved: [a1, a2, a3], expected: [] });
  }
  {
    const c = "c13_approved_equal";
    const shared = uid(`${c}:shared`);
    const o = obs(c, "o1", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { subject: ROSA, predicate: "is affiliated with", object: "Coldwell Banker Realty", category: "affiliation", existingStatus: "approved", claimId: shared });
    const a = appr(c, "a1", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { category: "affiliation", predicate: "is_affiliated_with", id: shared });
    add({ id: c, kind: "repeated known claim (approved, equal)", rule: "an observed claim already held as approved agrees", observed: [o], approved: [a], expected: [] });
  }
  {
    const c = "c14_subset_market";
    const o = obs(c, "o1", "Rosa Delgado serves Hoboken.", { subject: ROSA, predicate: "serves", object: "Hoboken", category: "market" });
    const a = appr(c, "a1", "Rosa Delgado serves Hoboken, Weehawken and Union City.", { category: "market", predicate: "serves" });
    add({ id: c, kind: "compatible detail (subset)", rule: "compatible detail", observed: [o], approved: [a], expected: [] });
  }
  {
    const c = "c15_more_than";
    const o = obs(c, "o1", "Rosa Delgado closed more than 25 transactions in 2025.", { subject: ROSA, predicate: "closed", object: "more than 25 transactions", category: "transaction" });
    const a = appr(c, "a1", "Rosa Delgado closed 31 transactions in 2025.", { category: "transaction", predicate: "closed", value: 31 });
    add({ id: c, kind: "compatible detail (lower bound)", rule: "compatible detail", observed: [o], approved: [a], expected: [] });
  }
  {
    const c = "c16_different_period";
    const o = obs(c, "o1", "Rosa Delgado closed 24 transactions in 2024.", { subject: ROSA, predicate: "closed", object: "24 transactions", category: "transaction", value: 24, asOf: "2024" });
    const a = appr(c, "a1", "Rosa Delgado closed 31 transactions in 2025.", { category: "transaction", predicate: "closed", value: 31, asOf: "2025" });
    add({ id: c, kind: "changed value (different period)", rule: "different periods are history, not conflict", observed: [o], approved: [a], expected: [] });
  }
  {
    const c = "c17_asof_only";
    const o = obs(c, "o1", "Harborline Homes Team is led by Rosa Delgado.", { subject: TEAM, predicate: "is led by", object: ROSA, category: "team", asOf: "2026-08-15" });
    const a = appr(c, "a1", "Harborline Homes Team is led by Rosa Delgado.", { category: "team", predicate: "led_by", asOf: "2025-01-10" });
    add({ id: c, kind: "changed date (asOf only, equal value)", rule: "same fact, only the observation date differs", observed: [o], approved: [a], expected: [] });
  }
  {
    const c = "c18_same_surname";
    const o = obs(c, "o1", "Daniel Delgado is an agent with Keller Williams Hoboken.", { subject: DANIEL, predicate: "is an agent with", object: "Keller Williams Hoboken", category: "affiliation" });
    const a = appr(c, "a1", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { category: "affiliation", predicate: "is_affiliated_with" });
    add({ id: c, kind: "different subject (same surname)", rule: "different subjects", observed: [o], approved: [a], expected: [] });
  }
  {
    const c = "c19_team_vs_agent";
    const o = obs(c, "o1", "Harborline Homes Team closed 68 transactions in 2025.", { subject: TEAM, predicate: "closed", object: "68 transactions", category: "transaction", value: 68 });
    const a = appr(c, "a1", "Rosa Delgado closed 31 transactions in 2025.", { category: "transaction", predicate: "closed", value: 31 });
    add({ id: c, kind: "different subject (team vs agent)", rule: "different subjects", observed: [o], approved: [a], expected: [] });
  }
  {
    const c = "c20_omission";
    const o = obs(c, "o1", "Rosa Delgado speaks English and Spanish.", { subject: ROSA, predicate: "speaks", category: "language" });
    const a = appr(c, "a1", "Rosa Delgado has been licensed in New Jersey since 2011.", { category: "licensing", predicate: "licensed_since" });
    const a2 = appr(c, "a2", "Rosa Delgado is affiliated with Coldwell Banker Realty.", { category: "affiliation", predicate: "is_affiliated_with" });
    add({ id: c, kind: "no contradiction (omission, no counterpart)", rule: "missing information is not a contradiction", observed: [o], approved: [a, a2], expected: [] });
  }
  return out;
}

const pairKey = (o: string, a: string) => `${o}→${a}`;

interface CanaryRun {
  caseId: string;
  kind: string;
  workflowRunId: string;
  projectId: string;
  llmCallId: string | null;
  backend: string | null;
  model: string | null;
  costMicroUsd: number | null;
  latencyMs: number;
  outcome: string;
  error: string | null;
  validation: "passed" | "guard_rejected" | "schema_failed" | "runtime_failed";
  reportedPairs: { pair: string; severity: string }[];
  expectedPairs: string[];
  branch: "no_error" | "severity" | null;
  falsePositives: string[];
  falseNegatives: string[];
  severityOk: boolean;
  correct: boolean;
}

class CanaryStop extends Error {}

async function main(): Promise<void> {
  const { sql } = await import("@/db/client");
  const store = await import("@/db/workflow");
  const { registerDefinition } = await import("@/lib/workflow/engine");
  const { getHandler } = await import("@/lib/workflow/handlers");
  const { registerAutomationNodes } = await import("@/lib/automation/nodes");
  const { profileCorrectionWorkflow } = await import("@/lib/automation/workflows/authority");
  const { inferenceTargetForTask } = await import("@/lib/ai/routing");
  const { AUTOMATION_PROMPTS } = await import("@/lib/automation/prompts");
  const { resolveAgentContext } = await import("@/lib/automation/nodes/agent");
  const { validateContradictionOutput } = await import("@/lib/automation/contradictions/contract");
  const { seedTestActors } = await import("@/tests/helpers/actors");
  const projectSvc = await import("@/lib/projects/service");

  // ---------------------------------------------------------- preflight
  const target = inferenceTargetForTask("detect_contradictions");
  const prompt = AUTOMATION_PROMPTS.detect_contradictions;
  console.log(`route: ${JSON.stringify(target)}`);
  console.log(`prompt: version=${prompt.version} backend=${prompt.backend} model=${prompt.model}`);
  if (
    target.backend !== CANARY_BACKEND ||
    target.model !== CANARY_MODEL ||
    target.execution !== "local" ||
    "think" in target ||
    prompt.backend !== CANARY_BACKEND ||
    prompt.model !== CANARY_MODEL ||
    prompt.version !== AGENT_VERSION
  ) {
    throw new CanaryStop("detect_contradictions does not resolve to ollama / qwen3:30b / v2 / default reasoning");
  }

  registerAutomationNodes();
  const compareHandler = getHandler("agt.detect_contradictions");
  const conditionHandler = getHandler("ctl.condition");
  const { versionId, version } = await registerDefinition(profileCorrectionWorkflow);
  const nodeDefs = await store.nodeDefinitionsFor(versionId);
  const compareDef = nodeDefs.get("compare")!;
  const hasErrorDef = nodeDefs.get("has_error")!;
  console.log(`workflow ${profileCorrectionWorkflow.key} v${version}: compare pinned to ${compareDef.agentVersion}, contextPaths ${JSON.stringify(compareDef.config?.contextPaths)}`);
  if (compareDef.agentVersion !== AGENT_VERSION) throw new CanaryStop("stored compare node is not pinned to v2");

  await seedTestActors(sql);
  const operator = {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@test.local",
    name: "Canary operator",
    role: "admin" as const,
  };
  const projects: string[] = [];
  for (const name of ["Spec 146 canary tenant A", "Spec 146 canary tenant B"]) {
    const created = await projectSvc.createProject(operator, { name });
    if (!created.ok) throw new Error(`project setup failed: ${created.error.message}`);
    projects.push(created.data.id);
  }

  const stamp = new Date().toISOString();

  /** One profile-correction run, up to and including has_error. */
  async function execute(c: CanaryCase, projectId: string, label: string) {
    const canonicalExtract = {
      sourceArtifactId: uid(`${c.id}:artifact`),
      sha256: createHash("sha256").update(c.observed.map((o) => o.originalWording).join("\n")).digest("hex"),
      duplicate: false,
      claims: c.observed,
      claimCount: c.observed.length,
      proposedCount: c.observed.filter((o) => !("existingStatus" in o)).length,
      matchedCount: c.observed.filter((o) => "existingStatus" in o).length,
      rejectedCount: 0,
      rejected: [],
    };
    const approvedFacts = packet(c.id, c.approved);
    const input = { payload: { profileUrl: `https://canary.invalid/spec146/${c.id}` } };

    const runId = await sql.begin(async (tx) => {
      const run = await store.insertRun(tx, {
        versionId,
        projectId,
        trigger: "manual",
        idempotencyKey: `spec146-canary:${stamp}:${label}`,
        input,
        costCapMicroUsd: null,
        maxParallel: 1,
        startedBy: operator.id,
      });
      for (const [key, output] of [
        ["canonical_extract", canonicalExtract],
        ["approved_facts", approvedFacts],
      ] as const) {
        await tx`
          insert into node_runs (workflow_run_id, node_id, node_key, state, attempts, output, started_at, finished_at)
          values (${run.id}, ${nodeDefs.get(key)!.id}, ${key}, 'succeeded', 1, ${tx.json(output as never)}, now(), now())
        `;
      }
      return run.id;
    });

    const ctx = {
      runId,
      projectId,
      nodeKey: "compare",
      fanKey: "",
      attempt: 1,
      // The engine's direct upstream of `compare` is `approved_facts`;
      // `canonical_extract` is read from this run's succeeded node_runs.
      inputs: { approved_facts: approvedFacts } as Record<string, unknown>,
      workflowInput: input,
      config: compareDef.config ?? {},
      node: compareDef,
      remainingCostMicroUsd: null,
    };

    // Isolation: the context the handler resolves is exactly this case's.
    const resolved = await resolveAgentContext(ctx);
    const isolated = isDeepStrictEqual(resolved, { observedClaims: c.observed, approvedFacts });

    const [{ marker }] = (await sql`select now() as marker`) as unknown as [{ marker: Date }];
    const started = Date.now();
    const result = await compareHandler(ctx);
    const latencyMs = Date.now() - started;
    const calls = await sql`
      select id, backend, model, cost_micro_usd, success, attempts, duration_ms
      from llm_calls where agent_version = ${AGENT_VERSION} and called_at >= ${marker}
      order by called_at asc
    `;

    let branch: "no_error" | "severity" | null = null;
    if (result.outcome === "succeeded") {
      await sql`
        insert into node_runs (workflow_run_id, node_id, node_key, state, attempts, output, confidence, started_at, finished_at)
        values (${runId}, ${compareDef.id}, 'compare', 'succeeded', 1, ${sql.json(result.output as never)},
          ${result.confidence ?? null}, now(), now())
      `;
      const cond = await conditionHandler({
        ...ctx,
        nodeKey: "has_error",
        inputs: { compare: result.output },
        config: hasErrorDef.config ?? {},
        node: hasErrorDef,
      });
      branch = cond.output?.result === true ? "severity" : "no_error";
    } else {
      await sql`
        insert into node_runs (workflow_run_id, node_id, node_key, state, attempts, error, started_at, finished_at)
        values (${runId}, ${compareDef.id}, 'compare', 'failed_terminal', 1, ${result.error ?? null}, now(), now())
      `;
    }
    return { runId, result, latencyMs, calls, isolated, branch, approvedFacts };
  }

  // ------------------------------------------------- warm-up (ungraded)
  const all = cases();
  if (all.length !== 20) throw new Error(`expected 20 canary cases, found ${all.length}`);
  const warm = await execute(all[0]!, projects[0]!, "warmup");
  console.log(`warm-up (ungraded): ${warm.latencyMs} ms outcome=${warm.result.outcome}`);

  // ------------------------------------------------------------ canary
  const runs: CanaryRun[] = [];
  let stopReason: string | null = null;
  for (const [i, c] of all.entries()) {
    const projectId = projects[i % 2]!;
    const { runId, result, latencyMs, calls, isolated, branch, approvedFacts } = await execute(c, projectId, c.id);
    const call = calls[0];
    const output = (result.output ?? {}) as Record<string, unknown>;
    const expectedKeys = c.expected.map((e) => pairKey(e.obs.claimId, e.appr.id));

    let validation: CanaryRun["validation"] = "passed";
    const error = result.outcome === "succeeded" ? null : (result.error ?? "unknown");
    if (error) {
      validation = error.includes("deterministic guard")
        ? "guard_rejected"
        : error.includes("produced invalid output twice")
          ? "schema_failed"
          : "runtime_failed";
    }

    const reported = Array.isArray(output.contradictions)
      ? (output.contradictions as { observedClaimId: string; approvedClaimId: string; severity: string }[])
      : [];
    const reportedPairs = reported.map((r) => ({ pair: pairKey(r.observedClaimId, r.approvedClaimId), severity: r.severity }));
    const falsePositives = reportedPairs.map((r) => r.pair).filter((p) => !expectedKeys.includes(p));
    const falseNegatives = result.outcome === "succeeded" ? expectedKeys.filter((k) => !reportedPairs.some((r) => r.pair === k)) : [];
    const severityOk = c.expected.every((e) => {
      const hit = reportedPairs.find((r) => r.pair === pairKey(e.obs.claimId, e.appr.id));
      if (!hit) return false;
      return e.floorHigh ? hit.severity === "high" || hit.severity === "critical" : true;
    });
    const expectedBranch = c.expected.length > 0 ? "severity" : "no_error";
    const correct =
      result.outcome === "succeeded" &&
      falsePositives.length === 0 &&
      falseNegatives.length === 0 &&
      severityOk &&
      branch === expectedBranch;

    const run: CanaryRun = {
      caseId: c.id,
      kind: c.kind,
      workflowRunId: runId,
      projectId,
      llmCallId: (call?.id as string | undefined) ?? null,
      backend: (call?.backend as string | undefined) ?? null,
      model: (call?.model as string | undefined) ?? null,
      costMicroUsd: call ? Number(call.costMicroUsd) : null,
      latencyMs,
      outcome: result.outcome,
      error,
      validation,
      reportedPairs,
      expectedPairs: expectedKeys,
      branch,
      falsePositives,
      falseNegatives,
      severityOk,
      correct,
    };
    runs.push(run);
    console.log(
      `[${String(i + 1).padStart(2, "0")}] ${c.id} run=${runId} ${run.backend}/${run.model} ${latencyMs}ms ` +
        `outcome=${result.outcome} validation=${validation} branch=${branch} ` +
        `pairs=${reportedPairs.map((r) => `${r.pair}:${r.severity}`).join(",") || "(none)"} ` +
        `cost=${run.costMicroUsd} ${correct ? "CORRECT" : "INCORRECT"}`
    );
    if (error) console.log(`     error: ${error.slice(0, 300)}`);

    // ----------------------------------------------- stop conditions
    if (calls.length !== 1) stopReason = `${c.id}: expected exactly 1 llm_calls row, found ${calls.length}`;
    else if (call!.backend !== CANARY_BACKEND || call!.model !== CANARY_MODEL) stopReason = `${c.id}: proprietary or unexpected inference (${call!.backend}/${call!.model})`;
    else if (Number(call!.costMicroUsd) !== 0) stopReason = `${c.id}: non-zero external cost`;
    else if (!isolated) stopReason = `${c.id}: resolved context is not this run's own context (isolation failure)`;
    else if (result.outcome === "succeeded") {
      const answer = { contradictions: output.contradictions, confidence: output.confidence };
      const recheck = validateContradictionOutput(answer, { observedClaims: c.observed, approvedFacts });
      if (!recheck.ok) stopReason = `${c.id}: a succeeded answer fails the validator — guard bypassed (${recheck.errors.join("; ")})`;
      else if (!Array.isArray(output.contradictions)) stopReason = `${c.id}: malformed answer recorded as succeeded`;
      else if (falseNegatives.length > 0) stopReason = `${c.id}: contradiction missed (${falseNegatives.join(", ")})`;
      else if (falsePositives.length > 0) stopReason = `${c.id}: false positive (${falsePositives.join(", ")})`;
      else if (branch !== expectedBranch) stopReason = `${c.id}: has_error routed to ${branch}, expected ${expectedBranch}`;
    } else if (branch !== null) {
      stopReason = `${c.id}: a failed comparison reached has_error`;
    }
    if (stopReason) break;
  }

  // ------------------------------------------------------------ summary
  const lat = runs.map((r) => r.latencyMs).sort((a, b) => a - b);
  const q = (p: number) => (lat.length === 0 ? null : lat[Math.min(lat.length - 1, Math.ceil(p * lat.length) - 1)]);
  const callIds = runs.map((r) => r.llmCallId).filter((x): x is string => x !== null);
  const ledger = callIds.length
    ? await sql`
        select backend, model, sum(cost_micro_usd)::bigint as cost, count(*)::int as n, bool_and(success) as all_success
        from llm_calls where id in ${sql(callIds)} group by backend, model
      `
    : [];
  const summary = {
    stopReason,
    runsCompleted: runs.length,
    correct: runs.filter((r) => r.correct).length,
    falsePositives: runs.reduce((n, r) => n + r.falsePositives.length, 0),
    falseNegatives: runs.reduce((n, r) => n + r.falseNegatives.length, 0),
    validatorFailures: runs.filter((r) => r.validation === "guard_rejected" || r.validation === "schema_failed").length,
    runtimeFailures: runs.filter((r) => r.validation === "runtime_failed").length,
    p50LatencyMs: q(0.5),
    p95LatencyMs: q(0.95),
    maxLatencyMs: lat.length ? lat[lat.length - 1] : null,
    warmUpMs: warm.latencyMs,
    ledger: ledger.map((r) => ({ backend: r.backend, model: r.model, costMicroUsd: Number(r.cost), calls: r.n, allSuccess: r.allSuccess })),
  };
  console.log(`\nCANARY_SUMMARY ${JSON.stringify(summary)}`);

  if (process.env.CANARY_OUT) {
    const reviewed = all.map((c) => ({
      caseId: c.id,
      kind: c.kind,
      rule: c.rule,
      page: c.observed.map((o) => ({ claimId: o.claimId, subject: o.subject, originalWording: o.originalWording, existingStatus: (o as { existingStatus?: string }).existingStatus ?? null, asOf: o.asOf })),
      approved: c.approved.map((a) => ({ id: a.id, text: a.text, asOf: a.asOf })),
      expected: c.expected.map((e) => pairKey(e.obs.claimId, e.appr.id)),
    }));
    writeFileSync(process.env.CANARY_OUT, JSON.stringify({ summary, runs, cases: reviewed }, null, 2));
  }
  await sql.end();
  if (stopReason || summary.correct !== 20) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
