/**
 * Spec 147 §5.4 and §6: the deterministic profile correction request.
 *
 * `buildProfileCorrectionRequest` turns Spec 146's validated contradiction
 * pairs into one correction item per pair, using only validated data: the
 * observed claim's verbatim page wording, the approved fact's exact text, its
 * key, as-of date and evidence ids, and the pair's severity. No model is
 * called and no wording is produced; the model's `explanation` is never copied.
 *
 * `validateProfileCorrectionRequest` proves a request is exactly what the
 * builder would produce from the same validated inputs and the database's
 * authoritative claim state. Contradiction semantics are not re-implemented:
 * both functions run the frozen Spec 146 context check and validator.
 *
 * Both are pure. The caller supplies `authority` — the current database rows
 * for every referenced approved claim and the before-page artifact — so
 * tenant, approval-status and evidence checks are deterministic and testable.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SEVERITIES,
  contradictionContextError,
  validateContradictionOutput,
  type ContradictionDetectionV2,
} from "@/lib/automation/contradictions/contract";
import { canonicalJson } from "@/lib/prospects/fact-manifest";
import { PROFILE_CORRECTION_REQUEST_VERSION } from "@/lib/profile-corrections/constants";

export { PROFILE_CORRECTION_REQUEST_VERSION };

type Severity = (typeof SEVERITIES)[number];

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const APPROVED_STATUS = "approved";
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------- schema

export const profileCorrectionItemSchema = z
  .object({
    observedClaimId: z.string().min(1),
    approvedClaimId: z.string().uuid(),
    approvedClaimKey: z.string().min(1),
    observedStatement: z.string().min(1),
    pageWording: z.string().min(1),
    approvedStatement: z.string().min(1),
    approvedAsOf: z.string().nullable(),
    severity: z.enum(SEVERITIES),
    evidenceIds: z.array(z.string().uuid()).min(1),
  })
  .strict();

export const profileCorrectionRequestSchema = z
  .object({
    version: z.literal(PROFILE_CORRECTION_REQUEST_VERSION),
    projectId: z.string().uuid(),
    workflowRunId: z.string().uuid(),
    profileUrl: z.string().url(),
    beforeSourceArtifactId: z.string().uuid(),
    beforeSha256: z.string().regex(SHA256_PATTERN),
    evidencePacketId: z.string().uuid(),
    items: z.array(profileCorrectionItemSchema).min(1),
    evidenceIds: z.array(z.string().uuid()).min(1),
    maxSeverity: z.enum(SEVERITIES),
  })
  .strict();

export type ProfileCorrectionItem = z.infer<typeof profileCorrectionItemSchema>;
export type ProfileCorrectionRequest = z.infer<typeof profileCorrectionRequestSchema>;

// --------------------------------------------------------------- inputs

/** The validated upstream outputs of one profile-correction run. */
export interface CorrectionContext {
  projectId: string;
  workflowRunId: string;
  /** `fetch_profile.data.url`. */
  profileUrl: unknown;
  /** `canonical_extract` output: `{ sourceArtifactId, sha256, claims }`. */
  canonicalExtract: unknown;
  /** `approved_facts` output: `{ packetId, claims: PacketClaim[] }`. */
  approvedFacts: unknown;
  /** `compare` output (Spec 146 v2). */
  compare: unknown;
}

/** Current database state for what a request references. */
export interface CorrectionAuthority {
  claims: { id: string; projectId: string; status: string; evidenceIds: string[] }[];
  sourceArtifact: { id: string; projectId: string; sha256: string } | null;
}

export type CorrectionBuild =
  | { ok: true; request: ProfileCorrectionRequest; requestSha256: string }
  | { ok: false; errors: string[] };

export type CorrectionValidation = { ok: true } | { ok: false; errors: string[] };

// ------------------------------------------------------------- helpers

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : null;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow).filter((r): r is Row => r !== null) : [];
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((x) => right.has(x));
}

/** sha256 of the request's canonical JSON — the identity a human approves. */
export function profileCorrectionRequestHash(request: unknown): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

function compareItems(a: ProfileCorrectionItem, b: ProfileCorrectionItem): number {
  const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;
  if (a.approvedClaimKey !== b.approvedClaimKey) return a.approvedClaimKey < b.approvedClaimKey ? -1 : 1;
  if (a.observedClaimId !== b.observedClaimId) return a.observedClaimId < b.observedClaimId ? -1 : 1;
  return 0;
}

/**
 * Every item's approved claim must exist, belong to this project, still be
 * approved, and carry exactly the evidence the request cites. Shared by the
 * builder and the validator so the rule exists once.
 */
function authorityErrors(
  projectId: string,
  items: readonly { approvedClaimId: string; evidenceIds: readonly string[] }[],
  authority: CorrectionAuthority
): string[] {
  const errors: string[] = [];
  const byId = new Map(authority.claims.map((c) => [c.id, c]));
  for (const item of items) {
    const claim = byId.get(item.approvedClaimId);
    if (!claim) {
      errors.push(`claim_missing: approved claim ${item.approvedClaimId} does not exist`);
      continue;
    }
    if (claim.projectId !== projectId) {
      errors.push(`cross_project: approved claim ${item.approvedClaimId} belongs to another project`);
      continue;
    }
    if (claim.status !== APPROVED_STATUS) {
      errors.push(`claim_not_approved: approved claim ${item.approvedClaimId} is now ${claim.status}`);
      continue;
    }
    if (!sameSet(claim.evidenceIds, item.evidenceIds)) {
      errors.push(`evidence_mismatch: evidence for ${item.approvedClaimId} is not the claim's current evidence set`);
    }
  }
  return errors;
}

function sourceArtifactErrors(
  projectId: string,
  artifactId: unknown,
  sha256: unknown,
  authority: CorrectionAuthority
): string[] {
  const artifact = authority.sourceArtifact;
  if (!artifact || artifact.id !== artifactId) {
    return [`source_missing: before-page artifact ${String(artifactId)} does not exist`];
  }
  if (artifact.projectId !== projectId) {
    return [`cross_project: before-page artifact ${artifact.id} belongs to another project`];
  }
  if (artifact.sha256 !== sha256) {
    return [`source_mismatch: before-page artifact ${artifact.id} hash does not match`];
  }
  return [];
}

interface ResolvedContext {
  observedClaims: Row[];
  approvedFacts: Row;
  approvedById: Map<string, Row>;
  observedById: Map<string, Row>;
  comparison: ContradictionDetectionV2;
  profileUrl: string | null;
  sourceArtifactId: string | null;
  sourceSha256: string | null;
  packetId: string | null;
}

/** Run the frozen Spec 146 checks and index the validated inputs. */
function resolveContext(context: CorrectionContext): { ok: true; value: ResolvedContext } | { ok: false; errors: string[] } {
  const extract = asRow(context.canonicalExtract) ?? {};
  const approvedFacts = asRow(context.approvedFacts) ?? {};
  const observedClaims = rows(extract.claims);
  const contextError = contradictionContextError({
    observedClaims: extract.claims,
    approvedFacts: context.approvedFacts,
  });
  if (contextError) return { ok: false, errors: [`context: ${contextError}`] };

  const checked = validateContradictionOutput(context.compare, {
    observedClaims: extract.claims,
    approvedFacts: context.approvedFacts,
  });
  if (!checked.ok) {
    return { ok: false, errors: checked.errors.map((e) => `contradiction_${checked.kind}: ${e}`) };
  }
  return {
    ok: true,
    value: {
      observedClaims,
      approvedFacts,
      observedById: new Map(observedClaims.map((c) => [String(c.claimId), c])),
      approvedById: new Map(rows(approvedFacts.claims).map((c) => [String(c.id), c])),
      comparison: checked.output,
      profileUrl: str(context.profileUrl),
      sourceArtifactId: str(extract.sourceArtifactId),
      sourceSha256: str(extract.sha256),
      packetId: str(approvedFacts.packetId),
    },
  };
}

// --------------------------------------------------------------- builder

export function buildProfileCorrectionRequest(
  context: CorrectionContext,
  authority: CorrectionAuthority
): CorrectionBuild {
  const resolved = resolveContext(context);
  if (!resolved.ok) return resolved;
  const r = resolved.value;

  if (r.comparison.contradictions.length === 0) {
    return { ok: false, errors: ["no_contradictions: a clean comparison has nothing to correct"] };
  }

  const errors: string[] = [];
  const items: ProfileCorrectionItem[] = [];
  for (const pair of r.comparison.contradictions) {
    const observed = r.observedById.get(pair.observedClaimId);
    const approved = r.approvedById.get(pair.approvedClaimId);
    if (!observed || !approved) {
      errors.push(`pair_unresolved: ${pair.observedClaimId} → ${pair.approvedClaimId}`);
      continue;
    }
    const pageWording = str(observed.originalWording);
    const approvedText = str(approved.text);
    const approvedKey = str(approved.key);
    const evidenceIds = strings(approved.evidenceIds);
    if (!pageWording) errors.push(`observed_wording_missing: ${pair.observedClaimId} has no verbatim page wording`);
    if (!approvedText || !approvedKey) errors.push(`approved_fact_missing: ${pair.approvedClaimId} has no text or key`);
    if (approved.stale === true) errors.push(`stale_fact: approved claim ${pair.approvedClaimId} is past its review date`);
    if (evidenceIds.length === 0) errors.push(`no_evidence: approved claim ${pair.approvedClaimId} has no evidence`);
    if (!pageWording || !approvedText || !approvedKey || approved.stale === true || evidenceIds.length === 0) continue;

    items.push({
      observedClaimId: pair.observedClaimId,
      approvedClaimId: pair.approvedClaimId,
      approvedClaimKey: approvedKey,
      observedStatement: pair.statementA,
      pageWording,
      approvedStatement: approvedText,
      approvedAsOf: str(approved.asOf) ?? str(approved.effectiveDate) ?? null,
      severity: pair.severity,
      evidenceIds: [...new Set(evidenceIds)].sort(),
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  errors.push(...authorityErrors(context.projectId, items, authority));
  errors.push(...sourceArtifactErrors(context.projectId, r.sourceArtifactId, r.sourceSha256, authority));
  if (errors.length > 0) return { ok: false, errors };

  items.sort(compareItems);
  const request = {
    version: PROFILE_CORRECTION_REQUEST_VERSION,
    projectId: context.projectId,
    workflowRunId: context.workflowRunId,
    profileUrl: r.profileUrl,
    beforeSourceArtifactId: r.sourceArtifactId,
    beforeSha256: r.sourceSha256,
    evidencePacketId: r.packetId,
    items,
    evidenceIds: [...new Set(items.flatMap((i) => i.evidenceIds))].sort(),
    maxSeverity: items.reduce<Severity>(
      (max, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[max] ? i.severity : max),
      "low"
    ),
  };
  const parsed = profileCorrectionRequestSchema.safeParse(request);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `schema: ${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, request: parsed.data, requestSha256: profileCorrectionRequestHash(parsed.data) };
}

// ------------------------------------------------------------- validator

export function validateProfileCorrectionRequest(
  candidate: unknown,
  context: CorrectionContext,
  authority: CorrectionAuthority
): CorrectionValidation {
  const parsed = profileCorrectionRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `schema: ${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const request = parsed.data;

  const resolved = resolveContext(context);
  if (!resolved.ok) return resolved;
  const r = resolved.value;
  const errors: string[] = [];

  // Scope: this project, this run, this page, this packet.
  if (request.projectId !== context.projectId) errors.push("tenant_mismatch: request is for another project");
  if (request.workflowRunId !== context.workflowRunId) errors.push("run_mismatch: request is for another run");
  if (request.profileUrl !== r.profileUrl) errors.push("profile_mismatch: request names another profile URL");
  if (request.beforeSourceArtifactId !== r.sourceArtifactId || request.beforeSha256 !== r.sourceSha256) {
    errors.push("source_mismatch: request cites another before-page artifact");
  }
  if (request.evidencePacketId !== r.packetId) errors.push("packet_mismatch: request cites another evidence packet");

  // Coverage: exactly the validated pairs, each once.
  const pairKey = (o: string, a: string) => `${o}\u0000${a}`;
  const expected = new Map(r.comparison.contradictions.map((c) => [pairKey(c.observedClaimId, c.approvedClaimId), c]));
  const seen = new Set<string>();
  for (const [i, item] of request.items.entries()) {
    const at = `items.${i}`;
    const key = pairKey(item.observedClaimId, item.approvedClaimId);
    if (seen.has(key)) {
      errors.push(`duplicate_item: ${at} repeats ${item.observedClaimId} → ${item.approvedClaimId}`);
      continue;
    }
    seen.add(key);
    const pair = expected.get(key);
    if (!pair) {
      errors.push(`extra_item: ${at} (${item.observedClaimId} → ${item.approvedClaimId}) is not a validated contradiction`);
      continue;
    }
    const observed = r.observedById.get(item.observedClaimId);
    const approved = r.approvedById.get(item.approvedClaimId);
    if (item.observedStatement !== pair.statementA) errors.push(`observed_statement_mismatch: ${at}`);
    if (!observed || item.pageWording !== observed.originalWording) errors.push(`page_wording_mismatch: ${at}`);
    if (!approved || item.approvedStatement !== approved.text) errors.push(`approved_fact_mismatch: ${at}`);
    if (!approved || item.approvedClaimKey !== approved.key) errors.push(`approved_key_mismatch: ${at}`);
    const asOf = approved ? str(approved.asOf) ?? str(approved.effectiveDate) ?? null : null;
    if (item.approvedAsOf !== asOf) errors.push(`as_of_mismatch: ${at}`);
    if (item.severity !== pair.severity) errors.push(`severity_mismatch: ${at}`);
    if (!approved || !sameSet(item.evidenceIds, strings(approved.evidenceIds))) {
      errors.push(`evidence_mismatch: ${at} does not cite the approved claim's evidence`);
    }
    if (approved?.stale === true) errors.push(`stale_fact: ${at} cites a stale approved claim`);
  }
  for (const [key, pair] of expected) {
    if (!seen.has(key)) {
      errors.push(`missing_item: ${pair.observedClaimId} → ${pair.approvedClaimId} is not covered`);
    }
  }

  // Derived fields.
  const union = [...new Set(request.items.flatMap((i) => i.evidenceIds))].sort();
  if (canonicalJson(request.evidenceIds) !== canonicalJson(union)) errors.push("derived_mismatch: evidenceIds");
  const maxSeverity = request.items.reduce<Severity>(
    (max, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[max] ? i.severity : max),
    "low"
  );
  if (request.maxSeverity !== maxSeverity) errors.push("derived_mismatch: maxSeverity");

  // Authority: the database still agrees.
  errors.push(...authorityErrors(context.projectId, request.items, authority));
  errors.push(...sourceArtifactErrors(context.projectId, request.beforeSourceArtifactId, request.beforeSha256, authority));

  // Finally: byte-identical to the deterministic build. Anything not caught
  // above — ordering, an added field value, reworded text — fails here.
  if (errors.length === 0) {
    const rebuilt = buildProfileCorrectionRequest(context, authority);
    if (!rebuilt.ok) {
      errors.push(...rebuilt.errors);
    } else if (rebuilt.requestSha256 !== profileCorrectionRequestHash(request)) {
      errors.push("not_deterministic: request differs from the deterministic build of the same inputs");
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Every approved-claim id a request (or the comparison feeding it) references. */
export function referencedApprovedClaimIds(compare: unknown, request?: unknown): string[] {
  const ids = new Set<string>();
  for (const c of rows(asRow(compare)?.contradictions)) {
    const id = str(c.approvedClaimId);
    if (id) ids.add(id);
  }
  for (const item of rows(asRow(request)?.items)) {
    const id = str(item.approvedClaimId);
    if (id) ids.add(id);
  }
  return [...ids];
}
