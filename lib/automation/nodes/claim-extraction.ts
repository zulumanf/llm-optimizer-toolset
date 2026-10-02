/**
 * `dom.extract_canonical_claims` — canonical claim extraction for an observed
 * public profile (spec 145B).
 *
 * The node composes the two canonical knowledge functions and adds no
 * extraction logic of its own:
 *
 *   fetch_profile (observed URL) → ingestSource → real sourceArtifactId
 *     → extractClaimsFromSource → proposed claims
 *
 * The page is ingested by URL rather than from the connector's excerpt: the
 * excerpt is the first 2,000 characters of raw HTML, which is mostly `<head>`,
 * and extracting from it would yield no claims and a false "clean profile".
 * Every claim lands as `proposed`; approval stays with a human.
 */
import { sql } from "@/db/client";
import { systemUser } from "@/lib/auth";
import { resolveObject } from "@/lib/automation/nodes/paths";
import { runModeFor } from "@/lib/automation/testmode";
import {
  loadClientSubjectIdentity,
  subjectAllowListFor,
} from "@/lib/knowledge/entities/subject-identity";
import { extractClaimsFromSource } from "@/lib/knowledge/extraction/claims";
import { ingestSource } from "@/lib/knowledge/sources/ingest";
import { log } from "@/lib/logger";
import type { NodeHandler, NodeResult } from "@/lib/workflow/types";

/** The processing status `extractClaimsFromSource` sets once it has run. */
const CLAIMS_PROPOSED_STATUS = "claims_proposed";

export const extractCanonicalProfileClaims: NodeHandler = async (ctx): Promise<NodeResult> => {
  if (ctx.projectId === null) {
    return {
      outcome: "failed_terminal",
      error: "canonical claim extraction requires a client scope",
    };
  }
  const projectId = ctx.projectId;

  const mode = await runModeFor(ctx.runId);
  if (mode.mode === "test") {
    // A test run must not fetch, call a model, or put proposals in a real
    // client's review queue — and no fixture may stand in for a source artifact.
    return {
      outcome: "safe_stop",
      reason:
        "canonical claim extraction ingests a live source and writes proposed claims; it does not run in test mode",
    };
  }

  // Spec 145D: a third-party page names other agents, brokerages and listings.
  // Only claims about the client's recorded identity may be proposed, and an
  // empty allow list would mean "no scoping", so it is refused rather than sent.
  const lookup = await loadClientSubjectIdentity(projectId);
  if (lookup.status !== "resolved") {
    return {
      outcome: "safe_stop",
      reason:
        "the client has no subject company, so claims on a third-party page cannot be attributed to it",
    };
  }
  const subjectAllowList = subjectAllowListFor(lookup.identity);
  if (subjectAllowList.length === 0) {
    return {
      outcome: "safe_stop",
      reason:
        "the client's recorded identity has no usable name, so claims on a third-party page cannot be attributed to it",
    };
  }

  const contextPath = ctx.config.contextPath === undefined ? "" : String(ctx.config.contextPath);
  const fetched = await resolveObject(ctx, contextPath);
  const data =
    fetched.data !== null && typeof fetched.data === "object" && !Array.isArray(fetched.data)
      ? (fetched.data as Record<string, unknown>)
      : {};

  if (fetched.ok !== true || fetched.skipped === true) {
    return {
      outcome: "safe_stop",
      reason: "the profile fetch did not succeed, so there is no observed page to extract from",
    };
  }
  if (data.reachable !== true) {
    return {
      outcome: "safe_stop",
      reason: "the profile page was not reachable, so there is no observed page to extract from",
    };
  }
  const url = typeof data.url === "string" ? data.url.trim() : "";
  if (url.length === 0) {
    return {
      outcome: "safe_stop",
      reason: "the profile fetch reported no URL, so there is no observed page to ingest",
    };
  }
  const provider =
    typeof fetched.provider === "string" && fetched.provider.length > 0
      ? fetched.provider
      : undefined;

  const user = await systemUser();

  const ingested = await ingestSource(user, {
    projectId,
    url,
    origin: "url_fetch",
    sourceType: "website",
    privacy: "public",
    ...(provider ? { provider } : {}),
    workflowRunId: ctx.runId,
  });
  if (!ingested.ok) {
    return {
      outcome: "failed_terminal",
      error: `Failed to ingest the profile: ${ingested.error.message}`,
    };
  }
  const artifact = ingested.data;

  if (artifact.duplicate) {
    const [row] = await sql`
      select processing_status from source_artifacts
      where id = ${artifact.sourceArtifactId} and project_id = ${projectId}
    `;
    if (!row) {
      return {
        outcome: "failed_terminal",
        error: "the ingested source artifact is not in this client's scope",
      };
    }
    if (row.processingStatus === CLAIMS_PROPOSED_STATUS) {
      // Re-extracting identical bytes would put a second copy of every claim in
      // the review queue; an empty result would falsely record a clean profile.
      return {
        outcome: "safe_stop",
        reason: `the profile is unchanged since source artifact ${artifact.sourceArtifactId}, whose claims are already proposed for review`,
        output: { sourceArtifactId: artifact.sourceArtifactId, duplicate: true },
      };
    }
  } else if (artifact.extractedTextLength === 0) {
    // The artifact is kept — it is evidence of what the page served.
    return {
      outcome: "safe_stop",
      reason: `source artifact ${artifact.sourceArtifactId} has no usable text to extract claims from`,
      output: { sourceArtifactId: artifact.sourceArtifactId, duplicate: false },
    };
  }

  const extracted = await extractClaimsFromSource(user, {
    sourceArtifactId: artifact.sourceArtifactId,
    subjectAllowList,
  });
  if (!extracted.ok) {
    return {
      outcome: "failed_terminal",
      error: `Failed to extract claims: ${extracted.error.message}`,
    };
  }

  log("info", "automation.canonical_claims", {
    node: ctx.nodeKey,
    sourceArtifactId: artifact.sourceArtifactId,
    proposed: extracted.data.proposed.length,
    matched: extracted.data.matched.length,
    rejected: extracted.data.rejected.length,
  });

  // Everything the page states about the client reaches `compare` — including
  // facts already held (spec 145E), so a recurring public error is still
  // compared even though it is not proposed again.
  const claims = [...extracted.data.proposed, ...extracted.data.matched];

  return {
    outcome: "succeeded",
    output: {
      sourceArtifactId: artifact.sourceArtifactId,
      sha256: artifact.sha256,
      duplicate: artifact.duplicate,
      claims,
      claimCount: claims.length,
      proposedCount: extracted.data.proposed.length,
      matchedCount: extracted.data.matched.length,
      rejectedCount: extracted.data.rejected.length,
      rejected: extracted.data.rejected,
    },
    costMicroUsd: extracted.data.costMicroUsd,
  };
};
