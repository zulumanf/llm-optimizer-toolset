"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  BookOpen,
  Building2,
  CheckCheck,
  ClipboardCheck,
  Crosshair,
  FileEdit,
  FileText,
  FlaskConical,
  LayoutDashboard,
  ListTodo,
  MessageSquareText,
  PlayCircle,
  Settings,
  Swords,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

export interface SidebarProject {
  id: string;
  name: string;
}

const PROJECT_SECTIONS = [
  { path: "", label: "Dashboard", icon: LayoutDashboard },
  { path: "/knowledge", label: "Knowledge", icon: BookOpen },
  { path: "/prompts", label: "Prompts", icon: MessageSquareText },
  { path: "/runs", label: "Runs", icon: PlayCircle },
  { path: "/review", label: "Review", icon: CheckCheck },
  { path: "/gaps", label: "Gaps", icon: Crosshair },
  { path: "/content", label: "Content", icon: FileEdit },
  { path: "/competitors", label: "Competitors", icon: Swords },
  { path: "/reports", label: "Reports", icon: FileText },
  { path: "/validation", label: "Validation", icon: ClipboardCheck },
  { path: "/interventions", label: "Interventions", icon: FlaskConical },
  { path: "/tasks", label: "Tasks", icon: ListTodo },
  { path: "/settings", label: "Settings", icon: Settings },
] as const;

function NavLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm",
        active
          ? "bg-accent font-medium text-accent-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
      )}
    >
      {children}
    </Link>
  );
}

export function SidebarNav({ projects }: { projects: SidebarProject[] }) {
  const pathname = usePathname();
  const projectMatch = pathname.match(/^\/projects\/([0-9a-f-]{36})(\/.*)?$/);
  const currentProject = projectMatch
    ? projects.find((p) => p.id === projectMatch[1])
    : undefined;
  const subPath = projectMatch?.[2] ?? "";

  if (currentProject) {
    return (
      <nav className="flex-1 overflow-y-auto p-2">
        <Link
          href="/projects"
          className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> All clients
        </Link>
        <p className="mb-1 mt-2 truncate px-3 text-sm font-semibold">
          {currentProject.name}
        </p>
        <ul className="space-y-0.5">
          {PROJECT_SECTIONS.map((section) => {
            const href = `/projects/${currentProject.id}${section.path}`;
            const active =
              section.path === ""
                ? subPath === "" || subPath === "/"
                : subPath.startsWith(section.path);
            const Icon = section.icon;
            return (
              <li key={section.label}>
                <NavLink href={href} active={active}>
                  <Icon className="size-4" /> {section.label}
                </NavLink>
              </li>
            );
          })}
        </ul>
      </nav>
    );
  }

  return (
    <nav className="flex-1 overflow-y-auto p-2">
      <ul className="space-y-0.5">
        <li>
          <NavLink href="/projects" active={pathname.startsWith("/projects")}>
            <Users className="size-4" /> Clients
          </NavLink>
        </li>
        <li>
          <NavLink href="/companies" active={pathname.startsWith("/companies")}>
            <Building2 className="size-4" /> Companies
          </NavLink>
        </li>
      </ul>
      {projects.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <p className="px-3 pb-1 text-xs font-medium uppercase text-muted-foreground">
            Active clients
          </p>
          <ul className="space-y-0.5">
            {projects.map((p) => (
              <li key={p.id}>
                <NavLink href={`/projects/${p.id}`} active={false}>
                  <span className="truncate">{p.name}</span>
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </nav>
  );
}
