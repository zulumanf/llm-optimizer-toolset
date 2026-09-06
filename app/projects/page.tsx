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
import { portfolioScan } from "@/lib/engagements/portfolio";

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
  const [projects, portfolio] = await Promise.all([
    listPortfolio({
      includeArchived,
      visibleIds: await visibleProjectIds(user),
      ownerId: owner ?? null,
      serviceTier: tierFilter,
    }),
    portfolioScan(new Date(), { includeRecentlyClosed: false, cache: true }),
  ]);
  const human = (v: string | null | undefined) => (v ?? "").replaceAll("_", " ");
  const WAITING: Record<string, string> = { us: "us", client: "client", third_party: "third party" };
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
      {portfolio.clients.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-2 text-lg font-medium">Active engagements</h2>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Market</TableHead>
                  <TableHead className="text-right">Day</TableHead>
                  <TableHead>Stage</TableHead>
                  <TableHead>Next action</TableHead>
                  <TableHead>Waiting on</TableHead>
                  <TableHead>Last change</TableHead>
                  <TableHead>Next measurement</TableHead>
                  <TableHead>Last update</TableHead>
                  <TableHead>Renewal</TableHead>
                  <TableHead>Billing</TableHead>
                  <TableHead>QA</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {portfolio.clients.map((c) => (
                  <TableRow key={c.overview.engagement.id}>
                    <TableCell className="font-medium">
                      <Link href={`/projects/${c.overview.engagement.projectId}/engagement`} className="underline-offset-2 hover:underline">{c.clientName}</Link>
                    </TableCell>
                    <TableCell>{c.overview.engagement.marketName}</TableCell>
                    <TableCell className="text-right tabular-nums">{c.engagementDay}</TableCell>
                    <TableCell><Badge variant="outline">{human(c.overview.derivedStage)}</Badge></TableCell>
                    <TableCell className="max-w-xs"><span className="line-clamp-2 text-xs">{c.alerts[0]?.nextAction ?? c.overview.nextAction}</span></TableCell>
                    <TableCell>{c.waitingOn ? WAITING[c.waitingOn] : "—"}</TableCell>
                    <TableCell className="text-xs">{c.overview.changes[0] ? formatDate(c.overview.changes[0].at) : "none"}</TableCell>
                    <TableCell className="text-xs tabular-nums">{c.overview.nextMeasurement?.scheduledFor ?? "none"}</TableCell>
                    <TableCell className="text-xs">{c.overview.lastClientUpdate ? formatDate(c.overview.lastClientUpdate.at) : "never"}</TableCell>
                    <TableCell className="text-xs tabular-nums">{c.overview.engagement.renewalReviewOn}</TableCell>
                    <TableCell><Badge variant={c.billingState === "PAYMENT_CURRENT" ? "outline" : "destructive"}>{human(c.billingState).toLowerCase()}</Badge></TableCell>
                    <TableCell><Badge variant={c.qaStatus === "CLEAR" ? "outline" : c.qaStatus === "P0" ? "destructive" : "secondary"}>{c.qaStatus}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}
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
