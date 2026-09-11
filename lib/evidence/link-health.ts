/**
 * Evidence-link health (2026-08-19): the receipts a prospect can click,
 * watched after publish. The publish-time check (lib/qa/preflight.ts
 * deadSourceLinks) verifies a link once and forgets; this module keeps an
 * append-only ledger (evidence_link_checks) so a receipt that later moves
 * or dies is KNOWN — the audit page can point to the current canonical URL
 * on a redirect, and stops rendering a known-dead link as healthy. The
 * original citation metadata (label, publisher, retrieved date) always
 * stays; only the live-link presentation degrades.
 *
 * Sweep cadence rides the worker tick's daily includeHealth lane
 * (lib/ops/tick.ts) — no scheduler of its own.
 */
import { sql } from "@/db/client";
import {
  safeFetch,
  type SafeFetchDeps,
} from "@/lib/security/safe-fetch";
import {
  SOURCE_LINK_TIMEOUT_MS,
  SOURCE_LINK_MAX_BYTES,
} from "@/lib/qa/preflight";
import type { AuditSnapshot } from "@/lib/prospects/audits";
import { log } from "@/lib/logger";

export type EvidenceLinkState =
  | "healthy"
  | "redirected"
  | "broken"
  | "unavailable"
  | "superseded";

export interface EvidenceLinkHealth {
  url: string;
  state: EvidenceLinkState;
  finalUrl: string | null;
  httpStatus: number | null;
  checkedAt: string;
}

/** Re-check cadence and per-sweep cap: evidence links change slowly, and
 * the sweep must never become a crawl. */
export const LINK_HEALTH_STALE_DAYS = 7;
export const LINK_HEALTH_SWEEP_CAP = 25;

/** Trailing-slash and fragment differences are not a "move". */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "");
  return norm(a) === norm(b);
}

/** Pure state derivation from a completed fetch — known-answer tested. */
export function deriveLinkState(result: {
  ok: boolean;
  status: number;
  url: string;
  finalUrl: string;
}): EvidenceLinkState {
  if (!result.ok) return "broken";
  return sameUrl(result.url, result.finalUrl) ? "healthy" : "redirected";
}

/**
 * How to present an evidence link given its latest known health. Unknown
 * (never checked) renders as-is; a redirect points the reader at the
 * current canonical page; a dead link is NOT rendered as a live link —
 * the citation metadata (publisher, retrieved date) remains the receipt.
 */
export function evidenceHref(
  originalUrl: string,
  health: EvidenceLinkHealth | null | undefined
): { href: string | null; moved: boolean } {
  if (!health || health.state === "healthy") {
    return { href: originalUrl, moved: false };
  }
  if (
    (health.state === "redirected" || health.state === "superseded") &&
    health.finalUrl
  ) {
    return { href: health.finalUrl, moved: false };
  }
  if (health.state === "broken" || health.state === "unavailable") {
    return { href: null, moved: true };
  }
  return { href: originalUrl, moved: false };
}

/** Every external receipt URL a snapshot renders as a clickable link. */
export function collectSnapshotEvidenceUrls(snapshot: AuditSnapshot): string[] {
  const urls = [
    snapshot.verifiedProduction?.sourceUrl,
    snapshot.humanFinding?.sourceUrl,
    snapshot.adoptionStat?.sourceUrl,
    ...(snapshot.authorityGap?.signals ?? []).map((s) => s.sourceUrl),
    ...(snapshot.exampleChats ?? []).map((c) => c.url),
  ];
  return [...new Set(urls.filter((u): u is string => Boolean(u)))];
}

/** Fetch one evidence URL and append the measured fact. A failed fetch is
 * recorded as 'unavailable' — never invented, never blocking. */
export async function checkEvidenceLink(
  url: string,
  deps: SafeFetchDeps = {}
): Promise<EvidenceLinkState> {
  let state: EvidenceLinkState = "unavailable";
  let finalUrl: string | null = null;
  let httpStatus: number | null = null;
  let error: string | null = null;
  try {
    const result = await safeFetch(
      url,
      { timeoutMs: SOURCE_LINK_TIMEOUT_MS, maxBytes: SOURCE_LINK_MAX_BYTES },
      deps
    );
    httpStatus = result.status;
    finalUrl = result.finalUrl;
    state = deriveLinkState({
      ok: result.ok,
      status: result.status,
      url,
      finalUrl: result.finalUrl,
    });
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 300) : "fetch failed";
  }
  await sql`
    insert into evidence_link_checks (url, final_url, http_status, state, error)
    values (${url}, ${finalUrl}, ${httpStatus}, ${state}, ${error})
  `;
  return state;
}

/** Latest known health per URL; URLs never checked are absent (render
 * as-is — unknown is not broken). */
export async function latestLinkHealth(
  urls: string[]
): Promise<Map<string, EvidenceLinkHealth>> {
  if (urls.length === 0) return new Map();
  const rows = await sql`
    select distinct on (url) url, final_url, http_status, state, checked_at
    from evidence_link_checks
    where url = any(${urls}::text[])
    order by url, checked_at desc
  `;
  return new Map(
    rows.map((r) => [
      r.url as string,
      {
        url: r.url as string,
        state: r.state as EvidenceLinkState,
        finalUrl: (r.finalUrl as string | null) ?? null,
        httpStatus: r.httpStatus === null ? null : Number(r.httpStatus),
        checkedAt: (r.checkedAt as Date).toISOString(),
      },
    ])
  );
}

/**
 * Daily sweep: every receipt URL on a LIVE (published, unexpired) audit,
 * re-checked when its latest check is older than LINK_HEALTH_STALE_DAYS.
 * Capped; skipped entirely when QA_SOURCE_LINK_CHECKS=off and no fetch impl
 * is injected — the test environment never touches the network (docs/09).
 */
export async function sweepEvidenceLinks(
  deps: SafeFetchDeps = {}
): Promise<{ checked: number; unhealthy: number }> {
  if (!deps.fetchImpl && process.env.QA_SOURCE_LINK_CHECKS === "off") {
    return { checked: 0, unhealthy: 0 };
  }
  const audits = await sql`
    select snapshot from prospect_audits
    where status = 'published' and (expires_at is null or expires_at > now())
  `;
  const urls = [
    ...new Set(
      audits.flatMap((row) =>
        collectSnapshotEvidenceUrls(row.snapshot as AuditSnapshot)
      )
    ),
  ];
  if (urls.length === 0) return { checked: 0, unhealthy: 0 };
  const recent = await sql`
    select distinct url from evidence_link_checks
    where url = any(${urls}::text[])
      and checked_at > now() - make_interval(days => ${LINK_HEALTH_STALE_DAYS})
  `;
  const fresh = new Set(recent.map((r) => r.url as string));
  const due = urls.filter((u) => !fresh.has(u)).slice(0, LINK_HEALTH_SWEEP_CAP);
  let unhealthy = 0;
  for (const url of due) {
    const state = await checkEvidenceLink(url, deps);
    if (state !== "healthy" && state !== "redirected") unhealthy += 1;
  }
  if (unhealthy > 0) {
    log("warn", "evidence.links_unhealthy", { checked: due.length, unhealthy });
  }
  return { checked: due.length, unhealthy };
}
