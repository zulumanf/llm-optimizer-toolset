import { signOut } from "@/app/login/actions";
import { PortalTabs } from "@/components/portal/portal-tabs";
import { requirePortalPage } from "@/lib/security/page-gates";
import { engagementForProject } from "@/lib/engagements/service";
import { portalTabs } from "@/lib/portal/client-copy";

/** The client dashboard shell (specs 031/154/155): project name, sign out,
 * and the five areas of a retained client — or the original three for a
 * project without an engagement. Access is gated by the parent layout. */
export default async function PortalDashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  // Its own gate: the parent layout's notFound() does not stop this one.
  const { project } = await requirePortalPage(projectId);
  const engaged = Boolean(await engagementForProject(projectId));

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-8 border-b pb-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Recommended First</p>
            <h1 className="truncate text-2xl font-semibold tracking-tight">{project.name}</h1>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="shrink-0 whitespace-nowrap rounded-sm py-1 text-sm text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Sign out
            </button>
          </form>
        </div>
        <PortalTabs tabs={portalTabs(projectId, engaged)} />
      </header>
      {children}
    </div>
  );
}
