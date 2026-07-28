import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listActiveCompanies, getSubjectCompany } from "@/db/companies";
import { listClaims } from "@/lib/claims/service";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import { SubjectSelector } from "@/components/knowledge/subject-selector";
import { ClaimCard } from "@/components/knowledge/claim-card";
import { ProposeClaimDialog } from "@/components/knowledge/propose-claim-dialog";

export default async function KnowledgePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [subject, companies, claims] = await Promise.all([
    getSubjectCompany(id),
    listActiveCompanies(),
    listClaims(id),
  ]);
  const evidenceIds = [...new Set(claims.flatMap((c) => c.evidenceIds))];
  const evidenceRows =
    evidenceIds.length > 0
      ? await sql`
          select id, url, note from evidence where id = any(${evidenceIds})
        `
      : [];
  const evidenceById = new Map(
    evidenceRows.map((e) => [
      e.id as string,
      { url: (e.url as string | null) ?? "", note: (e.note as string) ?? "" },
    ])
  );

  return (
    <div className="mx-auto max-w-4xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Knowledge
      </nav>

      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Client knowledge</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The verified factual record. Agents may only use approved claims —
          never invented or recalled facts (docs/15).
        </p>
      </div>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Subject (the client)</h2>
        <SubjectSelector
          projectId={id}
          currentCompanyId={subject?.id ?? null}
          companies={companies.map((c) => ({ id: c.id, name: c.name }))}
        />
        {subject && (
          <p className="mt-2 text-xs text-muted-foreground">
            Parsing and scoring for this project measure{" "}
            <span className="font-medium text-foreground">{subject.name}</span>
            {subject.domain ? ` (${subject.domain})` : ""} — aliases:{" "}
            {subject.aliases.length > 0 ? subject.aliases.join(", ") : "none"}.
            Edit aliases under Companies.
          </p>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium">Claims</h2>
          <ProposeClaimDialog projectId={id} />
        </div>
        {claims.length === 0 ? (
          <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
            No claims yet. Propose facts with evidence — approve them to make
            them agent-usable.
          </div>
        ) : (
          <div className="space-y-3">
            {claims.map((claim) => (
              <ClaimCard
                key={claim.id}
                claim={{
                  id: claim.id,
                  claimKey: claim.key,
                  canonicalText: claim.canonicalText,
                  asOf: claim.asOf,
                  status: claim.status,
                  evidence: claim.evidenceIds
                    .map((eid) => evidenceById.get(eid))
                    .filter((e): e is { url: string; note: string } => Boolean(e)),
                }}
              />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          <Badge variant="secondary" className="mr-1">approved</Badge> agent-usable ·{" "}
          <Badge variant="outline" className="mr-1">proposed</Badge> awaiting your review ·
          superseded/rejected kept for history
        </p>
      </section>
    </div>
  );
}
