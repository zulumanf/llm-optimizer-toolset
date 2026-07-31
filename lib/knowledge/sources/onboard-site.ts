/**
 * Discover and ingest a new client's website (spec 021 follow-up).
 *
 * Runs as a background job rather than inside onboarding, for one reason worth
 * stating: onboarding must not fail because a prospect's website is slow,
 * behind Cloudflare, or down. Creating the client, the prompt set and the
 * claims is the operator's work; fetching thirty pages over a polite crawl is
 * the platform's, and the two should not share a failure mode.
 *
 * Idempotent by construction. `ingestSource` deduplicates on
 * (project_id, sha256), so re-running after a partial failure re-fetches but
 * stores nothing twice — a page whose content has not changed is recorded as a
 * duplicate rather than a second artifact.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { log } from "@/lib/logger";
import { discoverSite } from "@/lib/knowledge/sources/discover";
import { ingestSource } from "@/lib/knowledge/sources/ingest";
import type { CurrentUser } from "@/lib/auth";

/**
 * Only pages that look like they carry audit-worthy facts AND actually
 * returned text. A 200 with 40 characters is a JavaScript shell, and storing
 * it would put an empty artifact in front of an operator as though it were
 * evidence.
 */
const MIN_SCORE = 65;
const MIN_TEXT_LENGTH = 500;

export interface SiteIngestResult {
  domain: string;
  discovered: number;
  ingested: number;
  duplicates: number;
  skippedThin: number;
  failed: number;
  notes: string[];
}

const inputSchema = z.object({
  projectId: z.string().uuid(),
  domain: z.string().trim().min(3).max(255),
  maxPages: z.number().int().min(1).max(200).default(30),
  createdBy: z.string().uuid().nullable().optional(),
});

export async function discoverAndIngestSite(raw: unknown): Promise<SiteIngestResult> {
  const input = inputSchema.parse(raw);

  const found = await discoverSite({ domain: input.domain, maxPages: input.maxPages });
  if (!found.ok) {
    log("warn", "knowledge.site_discovery_failed", {
      projectId: input.projectId,
      domain: input.domain,
      reason: found.error.message,
    });
    return {
      domain: input.domain,
      discovered: 0,
      ingested: 0,
      duplicates: 0,
      skippedThin: 0,
      failed: 0,
      notes: [`Discovery failed: ${found.error.message}`],
    };
  }

  // The job has no session, so it acts as the account that requested
  // onboarding. Attribution matters: these artifacts land in an audit trail.
  const actorId =
    input.createdBy ??
    ((await sql`select id from users where active order by created_at limit 1`)[0]?.id as
      | string
      | undefined);
  const user = { id: actorId ?? null } as unknown as CurrentUser;

  const candidates = found.data.pages.filter((p) => !p.error && p.score >= MIN_SCORE);
  const worth = candidates.filter((p) => p.textLength >= MIN_TEXT_LENGTH);
  const skippedThin = candidates.length - worth.length;

  let ingested = 0;
  let duplicates = 0;
  let failed = 0;

  for (const page of worth) {
    const result = await ingestSource(user, {
      projectId: input.projectId,
      origin: "url_fetch",
      url: page.url,
      sourceType: "website",
      // A public web page is public. Privacy classification protects client
      // material, not things anyone can already read.
      privacy: "public",
    });
    if (!result.ok) {
      failed += 1;
      log("warn", "knowledge.site_page_ingest_failed", {
        url: page.url,
        reason: result.error.message,
      });
      continue;
    }
    if (result.data.duplicate) duplicates += 1;
    else ingested += 1;
  }

  const notes = [...found.data.notes];
  if (skippedThin > 0) {
    notes.push(
      `${skippedThin} page(s) returned too little text to be worth storing — likely rendered by JavaScript.`
    );
  }
  if (failed > 0) notes.push(`${failed} page(s) could not be ingested.`);

  log("info", "knowledge.site_ingested", {
    projectId: input.projectId,
    domain: found.data.domain,
    discovered: found.data.pages.length,
    ingested,
    duplicates,
    failed,
  });

  return {
    domain: found.data.domain,
    discovered: found.data.pages.length,
    ingested,
    duplicates,
    skippedThin,
    failed,
    notes,
  };
}
