/**
 * Spec 147 — profile-correction domain nodes.
 *
 * `dom.fetch_public_profile` reads a public http(s) profile page through the
 * platform's one outbound-fetch policy (`safeFetch`: http(s) only, private and
 * link-local hosts refused, DNS-resolved addresses checked, every redirect hop
 * re-validated, size capped while streaming, bounded by a timeout). It needs
 * no connector: a third-party profile is not a WordPress site.
 *
 * Its output keeps the contract `dom.extract_canonical_claims` already reads
 * from `fetch_profile` — `{ ok, data: { url, reachable } }` — so canonical
 * extraction (Specs 145B–145E) is unchanged and still ingests the page itself
 * through `ingestSource(origin: "url_fetch")`. This node stores nothing; it is
 * the reachability gate. No `provider` is emitted, so the ingested artifact is
 * no longer labelled with an unrelated connector.
 */
import { resolve } from "@/lib/automation/nodes/paths";
import { runModeFor } from "@/lib/automation/testmode";
import { ClassifiedError, type ErrorKind } from "@/lib/errors";
import { SOURCE_FETCH_TIMEOUT_MS, SOURCE_MAX_BYTES } from "@/lib/knowledge/constants";
import { safeFetch } from "@/lib/security/safe-fetch";
import type { NodeHandler, NodeResult } from "@/lib/workflow/types";

/** Why the fetch produced no observed page (`ok: false`). */
export const PUBLIC_FETCH_REFUSAL = {
  noUrl: "no_url",
  policyRefused: "policy_refused",
} as const;

/**
 * Errors that mean "the page could not be reached" rather than "this target is
 * not allowed": network, DNS, redirect and timeout failures. A refusal by the
 * fetch policy (bad scheme, private host, size cap) is never "unreachable".
 */
const UNREACHABLE_ERROR_KINDS: readonly ErrorKind[] = ["timeout", "internal"];

export const fetchPublicProfile: NodeHandler = async (ctx): Promise<NodeResult> => {
  const mode = await runModeFor(ctx.runId);
  if (mode.mode === "test") {
    return {
      outcome: "safe_stop",
      reason: "a public profile fetch reaches a live third-party site; it does not run in test mode",
    };
  }

  const urlPath = typeof ctx.config.urlPath === "string" ? ctx.config.urlPath : "";
  const raw = urlPath.length > 0 ? await resolve(ctx, urlPath) : undefined;
  const url = typeof raw === "string" ? raw.trim() : "";
  if (url.length === 0) {
    // Never invent a URL (spec 145C): the run stops at canonical_extract.
    return {
      outcome: "succeeded",
      output: { ok: false, reason: PUBLIC_FETCH_REFUSAL.noUrl },
    };
  }

  try {
    const response = await safeFetch(url, {
      timeoutMs: SOURCE_FETCH_TIMEOUT_MS,
      maxBytes: SOURCE_MAX_BYTES,
    });
    return {
      outcome: "succeeded",
      output: {
        ok: true,
        data: {
          url,
          finalUrl: response.finalUrl,
          status: response.status,
          reachable: response.ok,
        },
      },
    };
  } catch (err) {
    const classified =
      err instanceof ClassifiedError ? err : new ClassifiedError("internal", String(err));
    if (UNREACHABLE_ERROR_KINDS.includes(classified.kind)) {
      return {
        outcome: "succeeded",
        output: {
          ok: true,
          data: { url, finalUrl: null, status: null, reachable: false, error: classified.message },
        },
      };
    }
    return {
      outcome: "succeeded",
      output: {
        ok: false,
        reason: PUBLIC_FETCH_REFUSAL.policyRefused,
        error: classified.message,
        errorKind: classified.kind,
      },
    };
  }
};

export const profileCorrectionNodes: Record<string, NodeHandler> = {
  "dom.fetch_public_profile": fetchPublicProfile,
};
