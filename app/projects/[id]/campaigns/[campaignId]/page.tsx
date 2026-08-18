import { PageHeader, PageShell } from "@/components/layout/page";
import { notFound } from "next/navigation";
import { campaignDetail } from "@/lib/campaigns/service";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CampaignTransitions } from "@/components/campaigns/campaign-transitions";

export const dynamic = "force-dynamic";

function pct(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string; campaignId: string }>;
}) {
  const { id, campaignId } = await params;
  const detail = await campaignDetail(campaignId);
  if (!detail || detail.projectId !== id) notFound();

  return (
    <PageShell className="space-y-6">
      <PageHeader
        title={detail.name}
        badge={
          <Badge variant={detail.status === "active" ? "default" : "secondary"}>
            {detail.status}
          </Badge>
        }
        description={
          <>
            {detail.objective}
            {detail.hypothesis && (
              <span className="mt-1 block">
                <span className="font-medium">Hypothesis:</span> {detail.hypothesis}
              </span>
            )}
          </>
        }
        actions={
          <CampaignTransitions campaignId={detail.id} status={detail.status} />
        }
      />

      <Card>
        <CardHeader>
          <CardTitle>Progress vs baseline</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.baseline === null ? (
            <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              No baseline yet — activation captures the subject&apos;s metrics
              from the latest scored run.
            </p>
          ) : detail.progress.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              No target metrics declared on this campaign.
            </p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    <TableHead>Baseline</TableHead>
                    <TableHead>Current</TableHead>
                    <TableHead>Delta</TableHead>
                    <TableHead>Target</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.progress.map((row) => (
                    <TableRow key={row.metric}>
                      <TableCell className="font-medium">{row.metric}</TableCell>
                      <TableCell>{pct(row.baseline)}</TableCell>
                      <TableCell>
                        {row.comparable ? pct(row.current) : (
                          <Badge variant="outline">not comparable</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        {row.delta === null ? "—" : pct(row.delta)}
                      </TableCell>
                      <TableCell>{pct(row.target / 100)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="mt-2 text-xs text-muted-foreground">
                Baseline captured from run {detail.baseline.runId.slice(0, 8)}…
                at scoring {detail.baseline.scoringVersion}. Deltas are
                observations, not causal claims — intervention verdicts
                (specs/007) remain the attribution instrument.
              </p>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members ({detail.members.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {detail.members.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              Nothing attached yet. Members are added from the service layer —
              a UI affordance on the gaps and tasks pages is a recorded
              follow-up (spec 029).
            </p>
          ) : (
            <ul className="space-y-1.5">
              {detail.members.map((m) => (
                <li key={`${m.kind}-${m.refId}`} className="flex items-center gap-2 text-sm">
                  <Badge variant="outline">{m.kind.replace("_", " ")}</Badge>
                  <span>{m.title}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageShell>
  );
}
