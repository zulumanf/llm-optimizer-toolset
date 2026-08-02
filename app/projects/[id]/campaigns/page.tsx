import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { listCampaigns } from "@/lib/campaigns/service";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CampaignFormDialog } from "@/components/campaigns/campaign-form-dialog";
import { formatDate } from "@/lib/format";
import { ProjectTabs } from "@/components/layout/project-tabs";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  active: "default",
  draft: "outline",
  completed: "secondary",
  abandoned: "secondary",
};

export default async function CampaignsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();
  const campaigns = await listCampaigns(id);

  return (
    <div className="mx-auto max-w-7xl p-6">
      <ProjectTabs projectId={id} setKey="work" />
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Campaigns</h1>
          <p className="text-sm text-muted-foreground">
            Named objectives with a baseline captured at activation — grouping
            prompts, findings, tasks, and interventions into one accountable
            program (spec 029).
          </p>
        </div>
        <CampaignFormDialog projectId={id} />
      </div>

      {campaigns.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
          No campaigns yet. Create one to group related work under an
          objective; activating it snapshots current metrics as the baseline.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Objective</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Members</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {campaigns.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/projects/${id}/campaigns/${c.id}`}
                    className="hover:underline"
                  >
                    {c.name}
                  </Link>
                </TableCell>
                <TableCell className="max-w-md truncate text-sm text-muted-foreground">
                  {c.objective}
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[c.status] ?? "outline"}>
                    {c.status}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">{c.memberCount}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDate(c.createdAt)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
