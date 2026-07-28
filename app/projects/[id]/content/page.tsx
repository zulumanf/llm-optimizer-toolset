import Link from "next/link";
import { notFound } from "next/navigation";
import { FileEdit } from "lucide-react";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { NewBriefButton } from "@/components/content/new-brief-button";
import { formatDate } from "@/lib/format";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  published: "default",
  approved: "default",
  verified: "secondary",
  drafted: "outline",
  briefed: "outline",
};

export default async function ContentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [assets, openFindings] = await Promise.all([
    sql`
      select id, title, asset_type, status, target_prompt, created_at
      from content_assets where project_id = ${id}
      order by created_at desc
    `,
    sql`
      select id, gap_type, finding, opportunity_score from gap_findings
      where project_id = ${id} and status != 'dismissed'
      order by opportunity_score desc limit 10
    `,
  ]);

  return (
    <div className="mx-auto max-w-5xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Clients</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}Content
      </nav>

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Content</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Brief → draft → verify → approve → publish. Drafts only use
            approved claims; the citation gate blocks everything else. You
            publish externally — recording it spawns the measuring
            intervention.
          </p>
        </div>
        <NewBriefButton
          findings={openFindings.map((f) => ({
            id: f.id as string,
            label: `[${Number(f.opportunityScore).toFixed(0)}] ${f.gapType}: ${String(f.finding).slice(0, 80)}…`,
          }))}
        />
      </div>

      {assets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <FileEdit className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No content yet — start a brief from a gap finding.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {assets.map((a) => (
                <TableRow key={a.id as string}>
                  <TableCell>
                    <Link
                      href={`/projects/${id}/content/${a.id}`}
                      className="font-medium hover:underline"
                    >
                      {a.title as string}
                    </Link>
                    {a.targetPrompt && (
                      <p className="truncate text-xs text-muted-foreground">
                        → {a.targetPrompt as string}
                      </p>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {(a.assetType as string).replace(/_/g, " ")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[a.status as string] ?? "outline"}>
                      {a.status as string}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDate(a.createdAt as Date)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
