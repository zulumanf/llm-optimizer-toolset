import { notFound } from "next/navigation";
import { EmptyState, PageHeader, PageShell, Section, Stat, StatGrid } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  BuildPlanButton,
  InitialAnalysisButton,
  OpportunityTransition,
  PrepareMeasurementForm,
} from "@/components/optimization/plan-controls";
import { OutcomeForm } from "@/components/optimization/outcome-form";
import { getProject } from "@/db/projects";
import { listClientOutcomes } from "@/lib/economics/service";
import { listPromptSets, listVersionSummaries } from "@/db/prompt-sets";
import { listPlans } from "@/lib/experiments/service";
import { onboardingChecklist } from "@/lib/onboarding/service";
import { listOpportunities } from "@/lib/optimization/plan";
import { sourcePresence } from "@/lib/optimization/source-presence";
import { structuredDataSuggestion } from "@/lib/optimization/structured-data";
import { requireStaffPage } from "@/lib/security/page-gates";

const BAND_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  do_now: "default",
  do_next: "secondary",
  test: "outline",
  low_priority: "outline",
};

const PRESENCE_LABEL: Record<string, string> = {
  client_present: "client on page",
  client_absent: "client not on page",
  not_checked: "page not checked",
  check_failed: "check failed",
};

export default async function OptimizationPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireStaffPage();
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [checklist, opportunities, presence, structured, plans, sets, outcomes] = await Promise.all([
    onboardingChecklist(user, id),
    listOpportunities(user, id),
    sourcePresence(id),
    structuredDataSuggestion(user, id, "agent_business"),
    listPlans(user, id),
    listPromptSets(id),
    listClientOutcomes(user, id),
  ]);
  const versions = (
    await Promise.all(
      sets.map(async (s) =>
        (await listVersionSummaries(s.id)).map((v) => ({ id: v.id, label: `${s.name} v${v.version} (${v.promptCount} prompts)` }))
      )
    )
  ).flat();
  const open = opportunities.filter((o) => o.status !== "closed" && o.status !== "dismissed");
  const done = checklist.steps.filter((s) => s.done).length;

  return (
    <PageShell>
      <PageHeader
        crumbs={[
          { label: "Projects", href: "/projects" },
          { label: project.name, href: `/projects/${id}` },
          { label: "Optimize" },
        ]}
        title="Optimize"
        description="Everything this client needs next: setup progress, one prioritized list of approvable work drawn from every finding, where AI answers get their information, and the experiments that will tell us what worked."
        actions={<BuildPlanButton projectId={id} />}
      />

      <Section
        title="Setup"
        description={checklist.next ? `Next: ${checklist.next.nextAction ?? checklist.next.label}` : "Setup complete."}
      >
        <StatGrid columns={3}>
          <Stat label="Setup steps done" value={`${done}/${checklist.steps.length}`} />
          <Stat label="Open opportunities" value={open.length} />
          <Stat label="Approved experiment plans" value={plans.filter((p) => p.status === "approved").length} />
        </StatGrid>
        <ul className="mt-3 grid gap-1 text-sm">
          {checklist.steps.map((s) => (
            <li key={s.key} className="flex flex-wrap items-baseline gap-2">
              <Badge variant={s.done ? "outline" : "secondary"}>{s.done ? "done" : s.actor}</Badge>
              <span className={s.done ? "text-muted-foreground" : ""}>{s.label}</span>
              <span className="text-xs text-muted-foreground">{s.evidence}</span>
            </li>
          ))}
        </ul>
        {!checklist.steps.find((s) => s.key === "baseline")?.done && (
          <div className="mt-4">
            <PrepareMeasurementForm projectId={id} versions={versions} />
          </div>
        )}
        {checklist.steps.find((s) => s.key === "baseline")?.done && !checklist.steps.find((s) => s.key === "plan")?.done && (
          <div className="mt-4">
            <InitialAnalysisButton projectId={id} />
          </div>
        )}
      </Section>

      <Section
        title="Opportunities"
        description="Deduplicated across runs and finding types. Each says what was observed, what to do, what a person must approve, and how it will be re-measured. None of it guarantees a recommendation."
      >
        {opportunities.length === 0 ? (
          <EmptyState message="No opportunities yet. Run a benchmark, analyze its gaps, scan the website, then refresh the plan." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Opportunity</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Needs approval for</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {opportunities.map((o) => (
                  <TableRow key={o.id}>
                    <TableCell className="max-w-md align-top text-sm">
                      <span className="font-medium">{o.title}</span>
                      <span className="block text-muted-foreground">{o.observedProblem}</span>
                      <span className="mt-1 block">{o.recommendedAction}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">{o.limitations}</span>
                    </TableCell>
                    <TableCell className="align-top tabular-nums">
                      <Badge variant={BAND_VARIANT[o.priorityBand] ?? "outline"}>{o.priorityBand.replaceAll("_", " ")}</Badge>
                      <span className="block text-xs text-muted-foreground">{o.priorityScore.toFixed(0)} · effort {o.effort}</span>
                    </TableCell>
                    <TableCell className="align-top text-xs">{o.approvalRequirements.map((a) => a.replaceAll("_", " ")).join(", ")}</TableCell>
                    <TableCell className="align-top">
                      <Badge variant="secondary">{o.status.replaceAll("_", " ")}</Badge>
                    </TableCell>
                    <TableCell className="align-top">
                      <OpportunityTransition opportunityId={o.id} status={o.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section
        title="Where AI answers get their information"
        description="Domains cited in this client's latest run. “With competitor” counts answers that also named a competitor — the answer, not the page. Page presence comes only from a fetched page check."
      >
        {presence.rows.length === 0 ? (
          <EmptyState message="No cited sources yet. They appear after a completed run whose answers carry citations." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead className="text-right">Answers citing</TableHead>
                  <TableHead className="text-right">With competitor</TableHead>
                  <TableHead className="text-right">With client</TableHead>
                  <TableHead>Page</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {presence.rows.map((r) => (
                  <TableRow key={r.domain}>
                    <TableCell className="text-sm">
                      {r.domain} {r.ownedByClient && <Badge variant="outline">client site</Badge>}
                      {r.candidate && <Badge variant="secondary">candidate</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{r.answersCiting}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.withCompetitor}</TableCell>
                    <TableCell className="text-right tabular-nums">{r.withClient}</TableCell>
                    <TableCell className="text-xs">{PRESENCE_LABEL[r.pagePresence]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section
        title="Structured data suggestion"
        description="Built only from approved facts. Missing facts are left out, never guessed; ratings and reviews are never generated. Publishing it is a website change the client approves."
      >
        <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">{JSON.stringify(structured.jsonLd, null, 2)}</pre>
        {structured.missingRecommended.length > 0 && (
          <p className="mt-2 text-xs text-muted-foreground">Approve these facts to complete it: {structured.missingRecommended.join(", ")}</p>
        )}
      </Section>

      <Section
        title="Client outcomes"
        description="What the client reports about leads and closings. Labelled by source and shown next to visibility as correlation only — never as proof that visibility caused them."
      >
        {outcomes.length > 0 && (
          <ul className="mb-3 grid gap-1 text-sm tabular-nums">
            {outcomes.map((o) => (
              <li key={o.id}>
                {o.periodStart} → {o.periodEnd}: {o.qualifiedLeads ?? "—"} qualified leads
                {o.aiDiscoveryMentions !== null && `, ${o.aiDiscoveryMentions} said AI`}
                {o.closedTransactions !== null && `, ${o.closedTransactions} closed`}{" "}
                <Badge variant="outline">{o.provenance === "self_reported" ? "self-reported" : "client system"}</Badge>
              </li>
            ))}
          </ul>
        )}
        <OutcomeForm projectId={id} />
      </Section>

      <Section title="Experiment plans" description="Pre-registered before a change ships; frozen once approved. Results are computed from the raw answers every time you look.">
        {plans.length === 0 ? (
          <EmptyState message="No experiment plans yet. Pre-register one for the first approved opportunity before it ships." />
        ) : (
          <ul className="grid gap-2 text-sm">
            {plans.map((p) => (
              <li key={p.id as string} className="rounded-md border p-3">
                <Badge variant="secondary">{p.status as string}</Badge> <span className="font-medium">{p.interventionType as string}</span>{" "}
                <span className="text-xs text-muted-foreground">
                  v{p.version as number} · {(p.primaryMetric as string).replaceAll("_", " ")} · {(p.design as string).replaceAll("_", " ")}
                </span>
                <span className="block text-muted-foreground">{p.hypothesis as string}</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </PageShell>
  );
}
