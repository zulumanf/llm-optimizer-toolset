/**
 * Live verification of shipped interventions (spec 051, audit F11). An
 * intervention that claims URLs shipped gets each one fetched through the
 * platform's single egress policy (safeFetch — SSRF-guarded, size-capped)
 * and the result recorded append-only. "We verify it actually shipped"
 * becomes a database fact instead of a sentence.
 *
 * A failed fetch is a recorded result, never an exception: an intervention
 * whose page 404s is exactly what this exists to catch.
 */
import { sql } from "@/db/client";
import { safeFetch, type SafeFetchDeps } from "@/lib/security/safe-fetch";
import { log } from "@/lib/logger";

const VERIFY_TIMEOUT_MS = 15_000;
const VERIFY_MAX_BYTES = 2 * 1024 * 1024;

export interface UrlCheck {
  url: string;
  ok: boolean;
  httpStatus: number | null;
  note: string | null;
  checkedAt: Date;
}

export async function verifyInterventionUrls(
  interventionId: string,
  deps: SafeFetchDeps = {}
): Promise<UrlCheck[]> {
  const [intervention] = await sql`
    select id, urls from interventions where id = ${interventionId}
  `;
  if (!intervention) {
    log("warn", "verify_urls.intervention_missing", { interventionId });
    return [];
  }
  const urls = (intervention.urls as string[]) ?? [];
  const results: UrlCheck[] = [];
  for (const url of urls) {
    let ok = false;
    let httpStatus: number | null = null;
    let note: string | null = null;
    try {
      const response = await safeFetch(
        url,
        { timeoutMs: VERIFY_TIMEOUT_MS, maxBytes: VERIFY_MAX_BYTES },
        deps
      );
      ok = response.ok;
      httpStatus = response.status;
      if (!response.ok) note = `HTTP ${response.status} ${response.statusText}`;
    } catch (err) {
      note = err instanceof Error ? err.message.slice(0, 300) : "fetch failed";
    }
    const [row] = await sql`
      insert into url_verifications (intervention_id, url, ok, http_status, note)
      values (${interventionId}, ${url}, ${ok}, ${httpStatus}, ${note})
      returning checked_at
    `;
    results.push({ url, ok, httpStatus, note, checkedAt: row!.checkedAt as Date });
    log(ok ? "info" : "warn", "verify_urls.checked", {
      interventionId,
      url,
      ok,
      httpStatus,
    });
  }
  return results;
}

/** Latest verification per URL for one intervention. */
export async function latestUrlChecks(interventionId: string): Promise<UrlCheck[]> {
  const rows = await sql`
    select distinct on (url) url, ok, http_status, note, checked_at
    from url_verifications
    where intervention_id = ${interventionId}
    order by url, checked_at desc
  `;
  return rows.map((r) => ({
    url: r.url as string,
    ok: r.ok as boolean,
    httpStatus: (r.httpStatus as number | null) ?? null,
    note: (r.note as string | null) ?? null,
    checkedAt: r.checkedAt as Date,
  }));
}
