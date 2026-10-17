import { notFound } from "next/navigation";
import { PageHeader, PageShell, Section } from "@/components/layout/page";
import { AddMemberForm, GrantAccessForm } from "@/components/organizations/org-forms";
import { ROSTER_NOTE, RosterTable } from "@/components/organizations/roster-table";
import { OrganizationAccessError, organizationFormData, organizationRoster } from "@/lib/organizations/service";
import { requireStaffPage } from "@/lib/security/page-gates";

export default async function OrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const user = await requireStaffPage();
  const { orgId } = await params;
  const roster = await organizationRoster(user, orgId).catch((err: unknown) => {
    if (err instanceof OrganizationAccessError) notFound();
    throw err;
  });
  const form = await organizationFormData(user);
  return (
    <PageShell>
      <PageHeader crumbs={[{ label: "Brokerages", href: "/organizations" }, { label: roster.organization }]} title={roster.organization} description={ROSTER_NOTE} />
      <Section title="Roster">
        <RosterTable rows={roster.rows} />
      </Section>
      <Section title="Add a member" description="Only agents and teams measured in a market benchmark can be added.">
        <AddMemberForm organizationId={orgId} companies={form.companies} />
      </Section>
      <Section title="Access" description="Granted accounts see this roster read-only in their portal, and nothing else of ours.">
        <GrantAccessForm organizationId={orgId} users={form.clientUsers} />
      </Section>
    </PageShell>
  );
}
