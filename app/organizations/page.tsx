import Link from "next/link";
import { EmptyState, PageHeader, PageShell, Section } from "@/components/layout/page";
import { CreateOrganizationForm } from "@/components/organizations/org-forms";
import { visibleOrganizations } from "@/lib/organizations/service";
import { requireStaffPage } from "@/lib/security/page-gates";

export default async function OrganizationsPage() {
  const user = await requireStaffPage();
  const orgs = await visibleOrganizations(user);
  return (
    <PageShell>
      <PageHeader
        title="Brokerages"
        description="Group the agents and teams a brokerage is responsible for and give its contact a read-only view of their AI visibility, from shared market benchmarks only."
      />
      <Section title="New brokerage">
        <CreateOrganizationForm />
      </Section>
      <Section title="Brokerages">
        {orgs.length === 0 ? (
          <EmptyState message="No brokerages yet. Create one, add its measured agents and teams, then grant its contact access." />
        ) : (
          <ul className="grid gap-2">
            {orgs.map((o) => (
              <li key={o.id} className="rounded-md border p-3 text-sm">
                <Link href={`/organizations/${o.id}`} className="font-medium underline-offset-4 hover:underline">{o.name}</Link>
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">{o.members} members</span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </PageShell>
  );
}
