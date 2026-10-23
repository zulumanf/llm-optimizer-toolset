import Link from "next/link";
import { EmptyState, PageHeader, PageShell, Section, Stat, StatGrid } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LaborForm } from "@/components/operations/labor-form";
import { ScenarioCalculator } from "@/components/operations/scenario-calculator";
import { listProjects } from "@/db/projects";
import { unitEconomics } from "@/lib/economics/service";
import { exceptionQueue } from "@/lib/operations/exceptions";
import { getCurrentUser } from "@/lib/auth";
import { requireStaffPage } from "@/lib/security/page-gates";

const SEVERITY: Record<string, "destructive" | "secondary" | "outline"> = { high: "destructive", medium: "secondary", low: "outline" };
const WINDOW_DAYS = 30;
const usd = (v: number | null) => (v === null ? "not recorded" : `$${v.toFixed(2)}`);

export default async function OperationsPage({ searchParams }: { searchParams: Promise<{ rate?: string }> }) {
  await requireStaffPage();
  const user = await getCurrentUser();
  const { rate } = await searchParams;
  const hourly = rate && Number(rate) > 0 ? Number(rate) : undefined;
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const [exceptions, economics, projects] = await Promise.all([
    exceptionQueue(user),
    unitEconomics(user, { from, to, assumedHourlyRateUsd: hourly }),
    listProjects({ includeArchived: false }),
  ]);
  const clients = economics.projects.filter((p) => p.kind === "client");
  const acquisition = economics.projects.filter((p) => p.kind !== "client");
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const deliveryHours = sum(clients.map((p) => p.deliveryHours.value));
  const salesHours = sum(economics.projects.map((p) => p.salesHours.value));

  return (
    <PageShell>
      <PageHeader
        title="Operations"
        description="What needs a person right now, and what delivery actually costs. Everything routine should be absent from the first list."
      />
      <Section title="Needs attention" description="Failures, overdue work and spend, across every client.">
        {exceptions.length === 0 ? (
          <EmptyState message="Nothing needs attention. Runs, retests, approvals, reviews and reports are on schedule." />
        ) : (
          <ul className="grid gap-2">
            {exceptions.map((e, i) => (
              <li key={`${e.kind}-${i}`} className="flex flex-wrap items-baseline gap-2 rounded-md border p-3 text-sm">
                <Badge variant={SEVERITY[e.severity]}>{e.severity}</Badge>
                {e.projectName && <span className="font-medium">{e.projectName}</span>}
                <span>{e.summary}</span>
                {e.href && <Link href={e.href} className="ml-auto text-xs underline-offset-4 hover:underline">Open</Link>}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={`Delivery cost, last ${WINDOW_DAYS} days`}
        description={hourly ? `Labor costed at an assumed $${hourly}/hour.` : "Labor is not costed until you choose a rate: add ?rate=<USD per hour> to the address."}
      >
        <StatGrid columns={4}>
          <Stat label="Client measurement spend" value={usd(sum(clients.map((p) => p.measurementCostUsd.value)))} />
          <Stat label="Acquisition benchmark spend" value={usd(sum(acquisition.map((p) => p.measurementCostUsd.value)))} />
          <Stat label="Delivery hours (logged)" value={deliveryHours.toFixed(1)} />
          <Stat label="Sales hours (logged)" value={salesHours.toFixed(1)} />
        </StatGrid>
        {clients.length === 0 ? (
          <EmptyState className="mt-3" message="No client projects yet. Costs appear per client once they are measured and time is logged." />
        ) : (
          <div className="mt-3 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead className="text-right">Revenue received</TableHead>
                  <TableHead className="text-right">Inference</TableHead>
                  <TableHead className="text-right">Delivery hours</TableHead>
                  <TableHead className="text-right">Contribution margin</TableHead>
                  <TableHead className="text-right">Failed cells</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((p) => (
                  <TableRow key={p.projectId ?? p.projectName}>
                    <TableCell>{p.projectName}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(p.revenueUsd.value)}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(p.measurementCostUsd.value + p.internalInferenceCostUsd.value)}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.deliveryHours.value.toFixed(1)}</TableCell>
                    <TableCell className="text-right tabular-nums">{usd(p.contributionMarginUsd.value)}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.failedCells}/{p.totalCells}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        <ul className="mt-3 list-disc pl-5 text-xs text-muted-foreground">
          {economics.notes.map((n) => <li key={n}>{n}</li>)}
          <li className="tabular-nums">Jobs failed after retries: {economics.failedJobs} of {economics.totalJobs}.</li>
        </ul>
      </Section>

      <Section title="Log time" description="The only way to know what a client costs to serve. Log delivery and sales time as it happens.">
        <LaborForm projects={projects.map((p) => ({ id: p.id, name: p.name }))} />
      </Section>

      <Section title="What would have to be true" description="A scenario model for 50–60% EBITDA at $0.5M–$3M revenue. Every number is an assumption you enter; none is a measured RF figure.">
        <ScenarioCalculator />
      </Section>
    </PageShell>
  );
}
