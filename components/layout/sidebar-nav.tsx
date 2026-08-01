"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Bell,
  Bot,
  Building2,
  CheckSquare,
  Gauge,
  LayoutDashboard,
  Shield,
  Users,
  Workflow,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PROJECT_SECTIONS } from "@/components/layout/sections";

export interface SidebarProject {
  id: string;
  name: string;
}


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

export function SidebarNav({
  projects,
  unreadCount = 0,
}: {
  projects: SidebarProject[];
  unreadCount?: number;
}) {
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
          <NavLink href="/" active={pathname === "/"}>
            <LayoutDashboard className="size-4" /> Today
          </NavLink>
        </li>
        <li>
          <NavLink href="/notifications" active={pathname.startsWith("/notifications")}>
            <Bell className="size-4" /> Inbox
            {unreadCount > 0 && (
              <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
                {unreadCount}
              </span>
            )}
          </NavLink>
        </li>
        <li>
          <NavLink href="/control-tower" active={pathname.startsWith("/control-tower")}>
            <Gauge className="size-4" /> Control tower
          </NavLink>
        </li>
        <li>
          <NavLink href="/approvals" active={pathname.startsWith("/approvals")}>
            <CheckSquare className="size-4" /> Approvals
          </NavLink>
        </li>
        <li>
          <NavLink href="/workflows" active={pathname.startsWith("/workflows")}>
            <Workflow className="size-4" /> Workflows
          </NavLink>
        </li>
        <li>
          <NavLink href="/automation" active={pathname.startsWith("/automation")}>
            <Zap className="size-4" /> Automation
          </NavLink>
        </li>
        <li>
          <NavLink href="/agents" active={pathname.startsWith("/agents")}>
            <Bot className="size-4" /> Agents
          </NavLink>
        </li>
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
        <li>
          <NavLink href="/exclusivity" active={pathname.startsWith("/exclusivity")}>
            <Shield className="size-4" /> Exclusivity
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
