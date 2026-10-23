import Link from "next/link";
import { isStaff } from "@/lib/auth";
import { requirePortalPage } from "@/lib/security/page-gates";

/** The portal's outer frame (spec 031): gate + staff-preview note. The
 * chrome lives one level down — the dashboard shell (`(dashboard)/layout.tsx`)
 * and the navigation-free onboarding (`welcome/`, spec 155). Each re-gates:
 * layouts render in parallel, so this one is not a boundary for its children. */
export default async function PortalProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const { user } = await requirePortalPage(projectId);

  return (
    <div className="min-h-dvh bg-muted/30">
      {isStaff(user) && (
        <p className="border-b bg-background px-4 py-1.5 text-center text-xs text-muted-foreground">
          Staff preview — this is what the client sees.{" "}
          <Link href={`/projects/${projectId}/delivery`} className="underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Back to the workspace
          </Link>
        </p>
      )}
      {children}
    </div>
  );
}
