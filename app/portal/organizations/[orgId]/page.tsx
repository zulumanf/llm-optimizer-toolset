import { notFound } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { ROSTER_NOTE, RosterTable } from "@/components/organizations/roster-table";
import { OrganizationAccessError, organizationRoster } from "@/lib/organizations/service";

export const dynamic = "force-dynamic";

/** Brokerage portal (spec 151 D1): read-only roster for granted accounts. */
export default async function PortalOrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const user = await getCurrentUser();
  const { orgId } = await params;
  const roster = await organizationRoster(user, orgId).catch((err: unknown) => {
    if (err instanceof OrganizationAccessError) notFound();
    throw err;
  });
  return (
    <div className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">{roster.organization}</h1>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">{ROSTER_NOTE}</p>
      <div className="mt-6">
        <RosterTable rows={roster.rows} />
      </div>
    </div>
  );
}
