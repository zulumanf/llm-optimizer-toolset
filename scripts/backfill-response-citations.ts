/**
 * Backfill the response_citations ledger (migration 033) from historical
 * immutable payloads. Deterministic and idempotent: extraction reads
 * response_text and raw_payload exactly as parse time does, and ON CONFLICT
 * DO NOTHING makes reruns free. Company attribution matches parse-time
 * behavior: domain suffix against the run's project-scoped companies.
 *
 * Usage: npx tsx scripts/backfill-response-citations.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const { sql } = await import("@/db/client");
  const { extractCitations } = await import("@/lib/ai/citations");
  const { extractUrls, urlDomain } = await import("@/lib/parsing/prepass");
  const { listCompaniesForProject } = await import("@/db/companies");

  const responses = await sql`
    select r.id, r.response_text, r.raw_payload, r.provider, ru.project_id
    from responses r
    join runs ru on ru.id = r.run_id
    where r.error is null
    order by r.requested_at asc
  `;

  const companyCache = new Map<
    string,
    { id: string; domain: string | null }[]
  >();
  let inserted = 0;
  let scanned = 0;

  for (const response of responses) {
    scanned += 1;
    const projectId = response.projectId as string;
    if (!companyCache.has(projectId)) {
      const companies = await listCompaniesForProject(projectId);
      companyCache.set(
        projectId,
        companies.map((c) => ({ id: c.id, domain: c.domain }))
      );
    }
    const companies = companyCache.get(projectId)!;

    const inText = extractUrls((response.responseText as string) ?? "");
    const search = extractCitations(
      response.provider as string,
      response.rawPayload
    ).map((c) => c.url);

    const rows = [
      ...[...new Set(inText)].map((url) => ({ url, kind: "in_text" })),
      ...[...new Set(search)].map((url) => ({ url, kind: "search" })),
    ];
    for (const row of rows) {
      const domain = urlDomain(row.url);
      if (!domain) continue;
      const owner = companies.find(
        (c) => c.domain && domain.endsWith(c.domain)
      );
      const result = await sql`
        insert into response_citations (response_id, url, domain, kind, company_id)
        values (${response.id as string}, ${row.url}, ${domain}, ${row.kind},
          ${owner?.id ?? null})
        on conflict (response_id, url, kind) do nothing
      `;
      inserted += result.count;
    }
  }

  console.log(`scanned ${scanned} responses, inserted ${inserted} citation rows`);
  await sql.end();
}

void main();
