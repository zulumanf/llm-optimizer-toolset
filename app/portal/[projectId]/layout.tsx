import Link from "next/link";
import { notFound, redirect } from "next/navigation";
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
    <div className="mx-auto max-w-5xl p-6">
      <header className="mb-6 border-b pb-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">
          AI Visibility Program
        </p>
        <h1 className="text-2xl font-semibold">{project.name}</h1>
        <nav className="mt-3 flex gap-4 text-sm">
          {tabs.map((tab) => (
            <Link
              key={tab.href}
              href={tab.href}
              className="text-muted-foreground hover:text-foreground"
            >
              {tab.label}
            </Link>
          ))}
        </nav>
      </header>
      {children}
    </div>
  );
}
