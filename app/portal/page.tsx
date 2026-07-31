import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser, isStaff, visibleProjectIds } from "@/lib/auth";
import { listActiveProjects } from "@/db/projects";

export const dynamic = "force-dynamic";

/** Portal landing (spec 031): a client's granted programs. One grant goes
 * straight in; staff see all active projects as preview links. */
export default async function PortalHome() {
  const user = await getCurrentUser();
  const visible = await visibleProjectIds(user);
  const projects = await listActiveProjects(visible);

  if (!isStaff(user) && projects.length === 1) {
    redirect(`/portal/${projects[0]!.id}`);
  }

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="text-2xl font-semibold">Your programs</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {isStaff(user)
          ? "Staff preview — every active client's portal."
          : "Select a program to view its visibility and work."}
      </p>
      {projects.length === 0 ? (
        <p className="mt-6 rounded-md border border-dashed p-8 text-sm text-muted-foreground">
          No programs are shared with this account yet. Your agency contact
          can grant access.
        </p>
      ) : (
        <ul className="mt-6 space-y-2">
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={`/portal/${p.id}`}
                className="block rounded-md border p-4 font-medium hover:bg-muted/40"
              >
                {p.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
