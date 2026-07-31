import { Shield } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { listActiveProjects } from "@/db/projects";
import {
  listAgreements,
  listChecks,
  listMarkets,
} from "@/lib/exclusivity/service";
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
import { CheckForm } from "@/components/exclusivity/check-form";
import { MarketDialog } from "@/components/exclusivity/market-dialog";
import { AgreementDialog } from "@/components/exclusivity/agreement-dialog";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Spec 028. Staff-only surface (middleware + layout auth); exclusivity is
 * agency-level data, so there is no per-project scoping here. */
export default async function ExclusivityPage() {
  const user = await getCurrentUser();
  const [markets, agreements, checks, projects] = await Promise.all([
    listMarkets(),
    listAgreements(),
    listChecks(30),
    listActiveProjects(),
  ]);

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Shield className="h-6 w-6" /> Market exclusivity
          </h1>
          <p className="text-sm text-muted-foreground">
            Protected markets, active agreements, and prospect conflict checks
            (spec 028). Every check is recorded immutably.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <MarketDialog markets={markets} />
          <AgreementDialog projects={projects} markets={markets} />
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Check a prospect</CardTitle>
        </CardHeader>
        <CardContent>
          {markets.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              No markets defined yet. Add the geography tree first (e.g. NYC →
              Manhattan → Tribeca) — conflict detection is structural, so a
              prospect can only be checked against a market that exists.
            </p>
          ) : (
            <CheckForm markets={markets} isAdmin={user.role === "admin"} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agreements ({agreements.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {agreements.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              No exclusivity agreements recorded.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Protected scopes</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Grace</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agreements.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="font-medium">{a.clientName}</TableCell>
                    <TableCell className="max-w-md">
                      <div className="flex flex-wrap gap-1">
                        {a.scopes.map((s) => (
                          <Badge key={s.id} variant="outline">
                            {s.marketName} · {s.serviceCategory ?? "all"} ·{" "}
                            {s.segment ?? "all"}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {a.startsOn} → {a.endsOn ?? "open-ended"}
                    </TableCell>
                    <TableCell className="text-sm">{a.gracePeriodDays}d</TableCell>
                    <TableCell>
                      <Badge variant={a.status === "active" ? "default" : "secondary"}>
                        {a.status}
                        {a.terminatedAt ? ` ${a.terminatedAt}` : ""}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent checks</CardTitle>
        </CardHeader>
        <CardContent>
          {checks.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              No prospect checks recorded yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Prospect</TableHead>
                  <TableHead>Scope asked</TableHead>
                  <TableHead>Verdict</TableHead>
                  <TableHead>Decision</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {checks.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.prospectName}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {c.marketName} · {c.serviceCategory ?? "all"} ·{" "}
                      {c.segment ?? "all"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.worstVerdict === "direct"
                            ? "destructive"
                            : c.worstVerdict === "clear"
                              ? "default"
                              : "secondary"
                        }
                      >
                        {c.worstVerdict}
                        {c.conflictCount > 0 ? ` ×${c.conflictCount}` : ""}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm">
                        {c.decision}
                        {c.overrideRationale ? " — " + c.overrideRationale : ""}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatDate(c.checkedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
