import { listActiveProjects } from "@/db/projects";
import { getCurrentUser } from "@/lib/auth";
import { unreadCount } from "@/lib/notifications/service";
import { SidebarNav } from "@/components/layout/sidebar-nav";

export async function Sidebar(): Promise<React.ReactElement> {
  const [projects, user, unread] = await Promise.all([
    listActiveProjects(),
    getCurrentUser(),
    unreadCount(),
  ]);

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="border-b p-4">
        <p className="text-sm font-semibold">AI Visibility OS</p>
        <p className="text-xs text-muted-foreground">
          client engagements · internal
        </p>
      </div>
      <SidebarNav
        projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        unreadCount={unread}
      />
      <div className="border-t px-4 py-3">
        <p className="truncate text-xs text-muted-foreground">
          {user.name} · {user.role}
        </p>
      </div>
    </aside>
  );
}
