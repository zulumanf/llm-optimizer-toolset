import { listActiveProjects } from "@/db/projects";
import { pendingApprovalsAcrossRuns } from "@/db/workflow";
import { getCurrentUserOrNull, isStaff, visibleProjectIds } from "@/lib/auth";
import { unreadCount } from "@/lib/notifications/service";
import { SidebarNav } from "@/components/layout/sidebar-nav";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { CommandPalette } from "@/components/layout/command-palette";

/**
 * Renders nothing without a session.
 *
 * `/login` lives inside the root layout, so throwing here would 500 the one
 * page whose entire job is to resolve an unauthenticated state — locking the
 * workspace out with no way back in. Invisible under `AUTH_MODE=dev`, where a
 * user always exists, which is why the test suite cannot catch it.
 *
 * This is a rendering decision, not the security boundary: every page and
 * server action calls `getCurrentUser()` itself and throws without a session.
 */
export async function Sidebar(): Promise<React.ReactElement | null> {
  const user = await getCurrentUserOrNull();
  if (!user) return null;
  // Client roles never see the internal nav — the portal carries its own
  // shell (spec 031). Rendering decision; every page still gates itself.
  if (!isStaff(user)) return null;

  // Loaded only once the caller is known — an unauthenticated request should
  // not reach the projects or notifications tables at all. Client roles see
  // only their granted projects; other clients' names never leave the DB.
  const visible = await visibleProjectIds(user);
  const [projects, unread, approvals] = await Promise.all([
    listActiveProjects(visible),
    unreadCount(),
    pendingApprovalsAcrossRuns(),
  ]);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <CommandPalette
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
      />
      <div className="border-b p-4">
        <p className="text-sm font-semibold">AI Visibility OS</p>
        <p className="text-xs text-muted-foreground">
          <kbd className="rounded border px-1 py-0.5 text-[10px]">⌘K</kbd> to
          jump anywhere
        </p>
      </div>
      <SidebarNav
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        unreadCount={unread}
        approvalsCount={approvals.length}
      />
      <div className="flex items-center justify-between gap-2 border-t px-4 py-3">
        <p className="truncate text-xs text-muted-foreground">
          {user.name} · {user.role}
        </p>
        <ThemeToggle />
      </div>
    </aside>
  );
}
