/**
 * Claim extraction from ingested source material (spec 020 Phase 2).
 *
 * Promotes the `claim_extraction` agent from `declared` to `implemented` in
 * `lib/agents/registry.ts`.
 *
 * The rule this module enforces structurally: **an agent proposes; it never
 * approves.** Every claim written here lands as `status = 'proposed'`. Nothing
 * in this file can write `approved` — the only path to approval is
 * `lib/claims/service.ts#approveClaim`, which requires a human.
 *
 * Two further guards, both deterministic and applied after the model returns:
 *
 *  - **Excerpt verification.** A proposed claim must quote text that appears
 *    verbatim in the extracted document. A quote the source does not contain is
 *    a fabrication, and it is dropped rather than reviewed (PRINCIPLES.md #5).
 *  - **Materiality classification.** Whether a claim is high-risk is decided by
 *    code from its category and wording, not by the model's opinion of its own
 *    output. A model that could grade its own risk would grade it low.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { runAgent, type AgentCaller, AGENT_MODEL } from "@/lib/ai/agent";
import { ClassifiedError } from "@/lib/errors";
import { publishEvent } from "@/lib/events/bus";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { log } from "@/lib/logger";
import { HIGH_RISK_CATEGORIES, SUPERLATIVE_MARKERS, type Materiality } from "@/lib/knowledge/constants";
import { scoreNameMatch } from "@/lib/knowledge/normalize";
import { latestExtraction } from "@/lib/knowledge/sources/ingest";
import { resolveEntityByName } from "@/lib/knowledge/entities/service";
import { scanProjectContradictions } from "@/lib/knowledge/contradictions/detect";

export const CLAIM_EXTRACTION_AGENT_VERSION = "claim-extraction-v1";

/** Categories the extractor may assign. Anything else becomes `general`. */
export const CLAIM_CATEGORIES = [
  "identity",
  "affiliation",
  "team",
  "market",
  "neighborhood",
  "specialty",
  "transaction",
  "sales_volume",
  "ranking",
  "award",
  "licensing",
  "service",
  "market_statistic",
  "general",
] as const;

const proposedClaimSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().default(""),
  /** How the source phrased it. Must appear verbatim in the document. */
  originalWording: z.string().min(1),
  /** Neutral restatement suitable as canonical text. */
  normalizedWording: z.string().min(1),
  category: z.string().default("general"),
  asOf: z.string().nullable().default(null),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]).default(null),
  confidence: z.number().min(0).max(1),
  /** The locator the extractor reported for this passage, when known. */
  locator: z.string().default(""),
});

export const claimExtractionOutputSchema = z.object({
  claims: z.array(proposedClaimSchema).default([]),
});
export type ClaimExtractionOutput = z.infer<typeof claimExtractionOutputSchema>;
export type ProposedClaimDraft = z.infer<typeof proposedClaimSchema>;

const SYSTEM = `You extract candidate factual claims from a client's source document.

Rules you must follow exactly:
- Extract ONLY what the document states. Never infer, never generalise, never add context you know from elsewhere.
- "originalWording" must be a VERBATIM span copied from the document. If you cannot quote it exactly, do not propose the claim.
- "normalizedWording" restates the same fact neutrally, with no marketing language and no superlatives.
- If the document gives a date for a fact, put it in "asOf" as YYYY-MM-DD. If it does not, use null. Never invent a date.
- Quantities go in "value" as a number where the document gives a number.
- "confidence" is how clearly the DOCUMENT states the fact, not how likely you think it is to be true.
- Do not propose a claim that is an opinion, a marketing slogan, or a prediction.
- Propose at most 40 claims. Prefer specific, checkable facts over broad ones.

Return JSON only:
{"claims":[{"subject":"","predicate":"","object":"","originalWording":"","normalizedWording":"","category":"","asOf":null,"value":null,"confidence":0.0,"locator":""}]}`;

export interface ExtractedClaimProposal extends ProposedClaimDraft {
  claimId: string;
  materiality: Materiality;
  requiresIndependentVerification: boolean;
  subjectEntityId: string | null;
  excerptVerified: boolean;
}

export interface ClaimExtractionResult {
  sourceArtifactId: string;
  proposed: ExtractedClaimProposal[];
  /** Claims the model returned that failed a deterministic guard. */
  rejected: { wording: string; reason: string }[];
  contradictionsDetected: number;
  costMicroUsd: number;
}

/**
 * Read a source's current extraction, ask the agent for candidate claims,
 * verify each one against the document, and store the survivors as proposals.
 */
export async function extractClaimsFromSource(
  user: CurrentUser,
  raw: unknown,
  options: { caller?: AgentCaller } = {}
): Promise<ActionResult<ClaimExtractionResult>> {
  assertCanWrite(user);
  const parsed = z
    .object({
      sourceArtifactId: z.string().uuid(),
      maxClaims: z.number().int().min(1).max(40).default(20),
      /**
       * Names a claim's subject must match to be kept — the client, its
       * aliases, and its named people.
       *
       * Omitted, every claim on the page is proposed, which is right for a
       * document the client supplied about themselves. Supplied, it keeps a
       * third-party page from filling the review queue with facts about other
       * businesses that happen to share an article (spec 027, first live run:
       * a Jersey Digs page proposed penthouse listings from unrelated
       * developments as claims about the client).
       */
      subjectAllowList: z.array(z.string().min(1)).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid extraction request."));
  }

  try {
    const [artifact] = await sql`
      select id, project_id, source_type, original_filename, original_url,
        extraction_status, privacy_classification,
        to_char(effective_date, 'YYYY-MM-DD') as effective_date
      from source_artifacts where id = ${parsed.data.sourceArtifactId}
    `;
    if (!artifact) throw new ClassifiedError("not_found", "Source not found.");
    if (artifact.extractionStatus !== "extracted") {
      throw new ClassifiedError(
        "conflict",
        `The source has no usable text (extraction status: ${artifact.extractionStatus}).`
      );
    }
    const extraction = await latestExtraction(artifact.id as string);
    if (!extraction || extraction.text.trim().length === 0) {
      throw new ClassifiedError("conflict", "The source has no extracted text.");
    }

    const projectId = artifact.projectId as string;
    const run = await runAgent({
      agentVersion: CLAIM_EXTRACTION_AGENT_VERSION,
      system: SYSTEM,
      user: buildExtractionPrompt({
        text: extraction.text,
        sourceLabel:
          (artifact.originalFilename as string | null) ??
          (artifact.originalUrl as string | null) ??
          (artifact.sourceType as string),
        maxClaims: parsed.data.maxClaims,
      }),
      schema: claimExtractionOutputSchema,
      model: AGENT_MODEL,
      caller: options.caller,
    });

    const rejected: { wording: string; reason: string }[] = [];
    const accepted: (ProposedClaimDraft & { materiality: Materiality; entityId: string | null })[] = [];

    for (const draft of run.output.claims.slice(0, parsed.data.maxClaims)) {
      const guard = verifyDraft(draft, extraction.text);
      if (!guard.ok) {
        rejected.push({ wording: draft.originalWording, reason: guard.reason });
        continue;
      }
      if (!subjectIsInScope(draft.subject, parsed.data.subjectAllowList)) {
        rejected.push({
          wording: draft.originalWording,
          reason: `The subject "${draft.subject}" is not this client or one of its people.`,
        });
        continue;
      }
      const resolved = await resolveEntityByName({
        projectId,
        name: draft.subject,
      });
      accepted.push({
        ...draft,
        category: normalizeCategory(draft.category),
        materiality: classifyMateriality(draft),
        // An ambiguous entity match does not get attached; the claim stays
        // reviewable with its free-text subject intact.
        entityId: resolved.matchStatus === "exact" ? resolved.entityId : null,
      });
    }

    const proposed: ExtractedClaimProposal[] = [];
    await sql.begin(async (tx) => {
      for (const draft of accepted) {
        const [evidenceRow] = await tx`
          insert into evidence (project_id, kind, ref_id, url, note, created_by)
          values (${projectId}, 'source', ${artifact.id}, ${artifact.originalUrl ?? null},
            ${excerptNote(draft)}, ${user.id})
          returning id
        `;
        const [claimRow] = await tx`
          insert into claims (
            project_id, key, canonical_text, value, as_of, status, evidence_ids,
            created_by, normalized_predicate, subject_entity, subject_entity_id,
            category, materiality, confidence, privacy_status, verification_status,
            source_artifact_ids
          ) values (
            ${projectId}, ${claimKey(draft)}, ${draft.normalizedWording},
            ${draft.value === null ? null : tx.json(draft.value as never)},
            ${draft.asOf ?? (artifact.effectiveDate as string | null) ?? null},
            'proposed', ${[evidenceRow!.id as string]}, ${user.id},
            ${normalizePredicate(draft.predicate)}, ${draft.subject}, ${draft.entityId},
            ${draft.category}, ${draft.materiality}, ${draft.confidence},
            ${artifact.privacyClassification}, 'unverified', ${[artifact.id as string]}
          )
          returning id
        `;
        const claimId = claimRow!.id as string;
        proposed.push({
          ...draft,
          claimId,
          subjectEntityId: draft.entityId,
          requiresIndependentVerification: draft.materiality === "high_risk",
          excerptVerified: true,
        });
        await publishEvent(tx, {
          type: "claim.proposed",
          projectId,
          payload: { claimId, subject: draft.subject },
        });
      }
      await tx`
        update source_artifacts set processing_status = 'claims_proposed'
        where id = ${artifact.id}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "knowledge.claims.extract",
        entity: "source_artifact",
        entityId: artifact.id as string,
        detail: { proposed: proposed.length, rejected: rejected.length },
      });
    });

    // New proposals can disagree with what is already believed. Detect now, so
    // the conflict reaches the reviewer with the claim rather than later.
    const scan = await scanProjectContradictions(projectId);

    log("info", "knowledge.claims.extracted", {
      sourceArtifactId: artifact.id as string,
      proposed: proposed.length,
      rejected: rejected.length,
      contradictions: scan.recorded,
    });

    return ok({
      sourceArtifactId: artifact.id as string,
      proposed,
      rejected,
      contradictionsDetected: scan.recorded,
      costMicroUsd: run.costMicroUsd,
    });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------------------------- guards

/**
 * Deterministic post-checks. Each rejection is a specific, greppable reason —
 * "the model was wrong" is not an actionable finding.
 */
export function verifyDraft(
  draft: ProposedClaimDraft,
  documentText: string
): { ok: true } | { ok: false; reason: string } {
  const quote = draft.originalWording.trim();
  if (quote.length < 3) {
    return { ok: false, reason: "The quoted wording is too short to verify." };
  }
  if (!containsNormalized(documentText, quote)) {
    // The single most important guard here: a quote the document does not
    // contain means the model wrote the fact rather than found it.
    return {
      ok: false,
      reason: "The quoted wording does not appear in the source document.",
    };
  }
  if (draft.asOf !== null && !/^\d{4}-\d{2}-\d{2}$/.test(draft.asOf)) {
    return { ok: false, reason: `"${draft.asOf}" is not a valid ISO date.` };
  }
  if (draft.normalizedWording.trim().length < 3) {
    return { ok: false, reason: "The normalized wording is empty." };
  }
  return { ok: true };
}

/**
 * Whether a claim's subject is the client or someone belonging to it.
 *
 * An empty or absent allow-list means "no scoping" — the caller is reading a
 * document about the client and everything in it is fair game. Discovery
 * supplies one because a third-party article is mostly *not* about the client:
 * the first live run proposed "The James unveiled two penthouses" as a claim,
 * which is true, sourced, verbatim, and about a different building entirely.
 *
 * `probable` counts: "JC Luxury at SERHANT." and "JC Luxury Group" are the same
 * subject, and demanding an exact string would reject the client's own name as
 * written by a journalist.
 */
export function subjectIsInScope(subject: string, allowList?: string[]): boolean {
  if (!allowList || allowList.length === 0) return true;
  return allowList.some((known) => {
    const match = scoreNameMatch(subject, known);
    return match.matchStatus === "exact" || match.matchStatus === "probable";
  });
}

/** Whitespace-insensitive containment: extraction reflows text, quotes should survive it. */
function containsNormalized(haystack: string, needle: string): boolean {
  const flatten = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  return flatten(haystack).includes(flatten(needle));
}

/**
 * Materiality is decided by code, from the category and the wording. A model
 * asked to grade the risk of its own output grades it low.
 */
export function classifyMateriality(draft: {
  category: string;
  normalizedWording: string;
  value?: unknown;
}): Materiality {
  const category = normalizeCategory(draft.category);
  if (HIGH_RISK_CATEGORIES.includes(category)) return "high_risk";

  const wording = draft.normalizedWording.toLowerCase();
  if (SUPERLATIVE_MARKERS.some((marker) => wording.includes(marker))) {
    // "the leading agent in Hoboken" is a high-risk claim whatever category
    // the extractor filed it under.
    return "high_risk";
  }
  if (typeof draft.value === "number" && draft.value !== 0) return "material";
  return "ordinary";
}

export function normalizeCategory(category: string): string {
  const value = category.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (CLAIM_CATEGORIES as readonly string[]).includes(value) ? value : "general";
}

export function normalizePredicate(predicate: string): string {
  return predicate.trim().toLowerCase().replace(/[\s-]+/g, "_").slice(0, 100);
}

function claimKey(draft: ProposedClaimDraft): string {
  const subject = draft.subject.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const predicate = normalizePredicate(draft.predicate);
  return `${subject}__${predicate}`.slice(0, 60).replace(/_+$/, "");
}

function excerptNote(draft: ProposedClaimDraft): string {
  const locator = draft.locator.trim();
  const where = locator.length > 0 ? ` (${locator})` : "";
  return `Source excerpt${where}: "${draft.originalWording.slice(0, 400)}"`;
}

function buildExtractionPrompt(args: {
  text: string;
  sourceLabel: string;
  maxClaims: number;
}): string {
  // The document is bounded here rather than in the agent runner so the bound
  // is visible at the call site where someone can reason about it.
  const MAX_DOC_CHARS = 60_000;
  const body =
    args.text.length > MAX_DOC_CHARS
      ? `${args.text.slice(0, MAX_DOC_CHARS)}\n\n[document truncated at ${MAX_DOC_CHARS} characters]`
      : args.text;
  return [
    `Source: ${args.sourceLabel}`,
    `Extract at most ${args.maxClaims} claims.`,
    "",
    "--- DOCUMENT START ---",
    body,
    "--- DOCUMENT END ---",
  ].join("\n");
}
