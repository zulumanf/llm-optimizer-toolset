import { notFound, redirect } from "next/navigation";
import { signOut } from "@/app/login/actions";
import { PortalTabs } from "@/components/portal/portal-tabs";
import {
  assertProjectAccess,
  getCurrentUser,
  NotAuthenticatedError,
  ProjectAccessError,
} from "@/lib/auth";
import { getProject } from "@/db/projects";

/** The portal's own shell (spec 031): project gate + minimal client nav.
 * Same 404-on-denial rule as the internal workspace. */
export default async function PortalProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  try {
    const user = await getCurrentUser();
    await assertProjectAccess(user, projectId);
  } catch (err) {
    if (err instanceof NotAuthenticatedError) redirect("/login");
    if (err instanceof ProjectAccessError) notFound();
    throw err;
  }
  const project = await getProject(projectId);
  if (!project) notFound();

  const tabs = [
    { href: `/portal/${projectId}`, label: "Overview" },
    { href: `/portal/${projectId}/work`, label: "Work" },
    { href: `/portal/${projectId}/reports`, label: "Reports" },
  ];

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <header className="mb-6 border-b pb-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              AI Visibility Program
            </p>
            <h1 className="text-2xl font-semibold">{project.name}</h1>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="text-xs text-muted-foreground underline-offset-2 hover:underline"
            >
              Sign out
            </button>
          </form>
        </div>
        <PortalTabs tabs={tabs} />
      </header>
      {children}
    </div>
  );
}
