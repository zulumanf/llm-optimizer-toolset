/**
 * Classify historical sources (migration 036). Idempotent per classifier
 * version: rows already stamped with the current version are skipped, so
 * shipping classifier v2 later reclassifies exactly once by bumping the
 * constant. Legacy rows with no project stay unclassified — relationship
 * is project-relative and unattributed rows have no subject to be
 * relative to.
 *
 * Usage: npx tsx scripts/classify-sources.ts
 */
import * as dotenv from "dotenv";
dotenv.config();

async function main() {
  const { sql } = await import("@/db/client");
  const { getSubjectCompany, listCompaniesForProject } = await import(
    "@/db/companies"
  );
  const { classifySource, SOURCE_CLASSIFIER_VERSION } = await import(
    "@/lib/sources/classify"
  );

  const projects = await sql`select id, name from projects`;
  let classified = 0;
  let skippedLegacy = 0;

  for (const project of projects) {
    const projectId = project.id as string;
    const subject = await getSubjectCompany(projectId);
    if (!subject) continue;
    const companies = await listCompaniesForProject(projectId);
    const context = {
      subjectDomain: subject.domain?.toLowerCase() ?? null,
      competitorDomains: companies
        .filter((c) => c.id !== subject.id && c.domain)
        .map((c) => (c.domain as string).toLowerCase()),
    };
    const rows = await sql`
      select id, domain from sources
      where project_id = ${projectId}
        and (classifier_version is null
          or classifier_version != ${SOURCE_CLASSIFIER_VERSION})
    `;
    for (const row of rows) {
      const result = classifySource(row.domain as string, context);
      await sql`
        update sources set
          source_type = ${result.sourceType},
          relationship = ${result.relationship},
          classifier_version = ${SOURCE_CLASSIFIER_VERSION},
          classified_at = now()
        where id = ${row.id}
      `;
      classified += 1;
    }
  }

  const [legacy] = await sql`
    select count(*)::int as n from sources where project_id is null
  `;
  skippedLegacy = Number(legacy?.n ?? 0);
  console.log(
    `classified ${classified} sources; ${skippedLegacy} legacy unattributed rows left unclassified`
  );
  await sql.end();
}

void main();
