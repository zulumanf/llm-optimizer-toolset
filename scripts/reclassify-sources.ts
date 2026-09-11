/**
 * Re-run source classification over existing `sources` rows (spec 086).
 *
 * The parse pipeline classifies at insert time and never revisits, so a
 * classifier upgrade (v1 → v2: industry_ranking, local_press) leaves
 * historical rows on the old labels. This re-derives source_type /
 * relationship per row with the CURRENT classifier and each row's project
 * context. Only classification metadata changes — citation counters and
 * identity are untouched, and response_citations (immutable evidence) is
 * never read or written.
 *
 * Usage: npx tsx scripts/reclassify-sources.ts [--dry-run]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { listCompaniesForProject, getSubjectCompany } from "@/db/companies";
import {
  classifySource,
  SOURCE_CLASSIFIER_VERSION,
} from "@/lib/sources/classify";

const dryRun = process.argv.includes("--dry-run");

async function main(): Promise<void> {
  const rows = await sql`
    select s.id, s.domain, s.project_id, s.source_type, s.relationship,
           s.classifier_version
    from sources s
    where s.classifier_version is distinct from ${SOURCE_CLASSIFIER_VERSION}
  `;
  console.log(`${rows.length} sources on older classifier versions`);

  // Context (subject + competitors) is per project; cache it.
  const contexts = new Map<
    string,
    { subjectDomain: string | null; competitorDomains: string[] }
  >();
  async function contextFor(projectId: string) {
    const cached = contexts.get(projectId);
    if (cached) return cached;
    const [subject, companies] = await Promise.all([
      getSubjectCompany(projectId),
      listCompaniesForProject(projectId),
    ]);
    const ctx = {
      subjectDomain: subject?.domain?.toLowerCase() ?? null,
      competitorDomains: companies
        .filter((c) => c.id !== subject?.id && c.domain)
        .map((c) => (c.domain as string).toLowerCase()),
    };
    contexts.set(projectId, ctx);
    return ctx;
  }

  let changed = 0;
  for (const row of rows) {
    const ctx = row.projectId
      ? await contextFor(row.projectId as string)
      : { subjectDomain: null, competitorDomains: [] };
    const next = classifySource(row.domain as string, ctx);
    const differs =
      next.sourceType !== row.sourceType ||
      next.relationship !== row.relationship;
    if (differs) {
      changed += 1;
      console.log(
        `${row.domain}: ${row.sourceType ?? "unclassified"} -> ${next.sourceType}` +
          (next.relationship !== row.relationship
            ? ` (${row.relationship ?? "?"} -> ${next.relationship})`
            : "")
      );
    }
    if (!dryRun) {
      await sql`
        update sources set
          source_type = ${next.sourceType},
          relationship = ${next.relationship},
          classifier_version = ${SOURCE_CLASSIFIER_VERSION},
          classified_at = now()
        where id = ${row.id}
      `;
    }
  }
  console.log(
    `${dryRun ? "[dry-run] would relabel" : "relabeled"} ${changed} of ${rows.length}; ` +
      `all ${dryRun ? "would be" : ""} stamped ${SOURCE_CLASSIFIER_VERSION}`
  );
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
