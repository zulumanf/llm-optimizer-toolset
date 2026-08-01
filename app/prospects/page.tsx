import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, PageHeader, PageShell, Section } from "@/components/layout/page";
import { LaunchDialog } from "@/components/prospects/launch-dialog";
import { ProspectDialog } from "@/components/prospects/prospect-dialog";
import { listLaunches, listProspects } from "@/lib/prospects/service";
import { listMarkets } from "@/lib/exclusivity/service";

export default async function ProspectsPage() {
  const [launches, prospects, markets] = await Promise.all([
    listLaunches(),
    listProspects({ limit: 100 }),
    listMarkets(),
  ]);

  return (
    <PageShell>
      <PageHeader
        title="Prospects"
        description="Market launches and the account-based acquisition pipeline: benchmark evidence in, human-reviewed outreach out."
        actions={
          <>
            <LaunchDialog markets={markets.map((m) => ({ id: m.id, name: m.name, parentName: m.parentName }))} />
            <ProspectDialog launches={launches.map((l) => ({ id: l.id, name: l.name }))} />
          </>
        }
      />

      <Section
        title="Market launches"
        description="One launch per market we are pursuing for an exclusive partner."
      >
        {launches.length === 0 ? (
          <EmptyState message="No market launches yet. Create one to start researching a market — it links to the exclusivity market tree." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Launch</TableHead>
                <TableHead>Market</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Prospects</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {launches.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.name}</TableCell>
                  <TableCell>{l.marketName}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{l.status.replaceAll("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>{l.ownerName ?? "—"}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {l.prospectCount}
                    {l.targetProspectCount ? ` / ${l.targetProspectCount}` : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section
        title="Prospects"
        description="Selectively targeted teams — every stage change is checked against exclusivity."
      >
        {prospects.length === 0 ? (
          <EmptyState message="No prospects yet. Add a leading team to a launch to begin benchmarking it." />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Business</TableHead>
                <TableHead>Launch</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Stage</TableHead>
                <TableHead>Conflict</TableHead>
                <TableHead>Next action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {prospects.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    <Link href={`/prospects/${p.id}`} className="hover:underline">
                      {p.businessName}
                    </Link>
                    {p.doNotContact && (
                      <Badge variant="destructive" className="ml-2">
                        do not contact
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{p.launchName}</TableCell>
                  <TableCell>{p.prospectType.replaceAll("_", " ")}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{p.stage.replaceAll("_", " ")}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        p.conflictStatus === "clear" || p.conflictStatus === "override"
                          ? "outline"
                          : p.conflictStatus === "unchecked"
                            ? "secondary"
                            : "destructive"
                      }
                    >
                      {p.conflictStatus}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {p.nextAction ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>
    </PageShell>
  );
}
