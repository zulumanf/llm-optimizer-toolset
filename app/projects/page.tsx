import { PageHeader, PageShell } from "@/components/layout/page";
import Link from "next/link";
import { FolderPlus } from "lucide-react";
import { listPortfolio } from "@/db/projects";
import { getCurrentUser, visibleProjectIds } from "@/lib/auth";
import { requireStaffPage } from "@/lib/security/page-gates";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProjectFormDialog } from "@/components/projects/project-form-dialog";
import { formatDate } from "@/lib/format";

const TIERS = ["standard", "premium", "exclusive"] as const;

export default async function ProjectsPage({
  searchParams,
}: {
  searchParams: Promise<{ archived?: string; owner?: string; tier?: string }>;
}) {
  await requireStaffPage(); // clients get /portal, not the internal list
  const { archived, owner, tier } = await searchParams;
  const includeArchived = archived === "1";
  const tierFilter = (TIERS as readonly string[]).includes(tier ?? "")
    ? (tier as string)
    : null;
  const user = await getCurrentUser();
  const projects = await listPortfolio({
    includeArchived,
    visibleIds: await visibleProjectIds(user),
    ownerId: owner ?? null,
    serviceTier: tierFilter,
  });
  const filterHref = (next: { owner?: string | null; tier?: string | null }) => {
    const params = new URLSearchParams();
    if (includeArchived) params.set("archived", "1");
    const nextOwner = next.owner === undefined ? owner : next.owner;
    const nextTier = next.tier === undefined ? tierFilter : next.tier;
    if (nextOwner) params.set("owner", nextOwner);
    if (nextTier) params.set("tier", nextTier);
    const query = params.toString();
    return query ? `/projects?${query}` : "/projects";
  };

  return (
    <PageShell>
      <PageHeader
        title="Clients"
        actions={
          <>
            <div className="flex items-center gap-3">
          <Link
            href={includeArchived ? "/projects" : "/projects?archived=1"}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            {includeArchived ? "Hide archived" : "Show archived"}
          </Link>
          <div className="flex gap-2">
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Onboard client
            </Link>
            <ProjectFormDialog mode="create" />
          </div>
        </div>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Tier:</span>
        <Link href={filterHref({ tier: null })}>
          <Badge variant={tierFilter === null ? "default" : "outline"}>all</Badge>
        </Link>
        {TIERS.map((t) => (
          <Link key={t} href={filterHref({ tier: t })}>
            <Badge variant={tierFilter === t ? "default" : "outline"}>{t}</Badge>
          </Link>
        ))}
        {owner && (
          <Link href={filterHref({ owner: null })}>
            <Badge variant="secondary">owner filter × clear</Badge>
          </Link>
        )}
      </div>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <FolderPlus className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No projects yet — create your first project.
          </p>
          <div className="flex gap-2">
            <Link
              href="/onboarding"
              className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Onboard client
            </Link>
            <ProjectFormDialog mode="create" />
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Client / project</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead>Tier</TableHead>
                <TableHead>Subject</TableHead>
                <TableHead className="text-right">Authority</TableHead>
                <TableHead className="text-right">Open gaps</TableHead>
                <TableHead>Last run</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {projects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Link
                      href={`/projects/${p.id}`}
                      className="font-medium hover:underline"
                    >
                      {p.name}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {p.promptSetCount} set{p.promptSetCount === 1 ? "" : "s"} ·{" "}
                      {p.runCount} run{p.runCount === 1 ? "" : "s"} · since{" "}
                      {formatDate(p.createdAt)}
                    </p>
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.accountOwnerId ? (
                      <Link
                        href={filterHref({ owner: p.accountOwnerId })}
                        className="hover:underline"
                      >
                        {p.accountOwnerName}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.serviceTier ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.subjectName ?? (
                      <span className="text-warning">no subject</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.authorityScore != null
                      ? Number(p.authorityScore).toFixed(1)
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {p.openFindings > 0 ? p.openFindings : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {p.lastRunLabel ? (
                      <>
                        {p.lastRunLabel}{" "}
                        <Badge variant="outline">{p.lastRunStatus}</Badge>
                      </>
                    ) : (
                      "never"
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.status === "active" ? "default" : "outline"}>
                      {p.status}
                    </Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}
