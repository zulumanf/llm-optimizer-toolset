"use client";

/**
 * The sidebar's two states (spec 037): a global map (attention → clients →
 * prospects, with the machinery demoted into a collapsible System group)
 * and a project map (the operator's reading order as visible groups).
 * Same-question routes share one entry via TAB_SETS; every demoted page
 * stays a real URL reachable from its tab bar and ⌘K.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Bot,
  Building2,
  CheckSquare,
  ChevronRight,
  Crosshair,
  FlaskConical,
  ListTodo,
  Gauge,
  LayoutDashboard,
  Shield,
  Users,
  GraduationCap,
  Workflow,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PROJECT_NAV_GROUPS,
  sectionFor,
  tabSetFor,
} from "@/components/layout/sections";

export interface SidebarProject {
  id: string;
  name: string;
}

const SYSTEM_LINKS = [
  { href: "/control-tower", label: "Control tower", icon: Gauge },
  { href: "/workflows", label: "Workflows", icon: Workflow },
  { href: "/automation", label: "Automation", icon: Zap },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/learnings", label: "Learnings", icon: GraduationCap },
  { href: "/exclusivity", label: "Exclusivity", icon: Shield },
  { href: "/dogfood", label: "Dogfood", icon: FlaskConical },
] as const;

const SYSTEM_OPEN_KEY = "nav:system-open";

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
      {count > 99 ? "99+" : count}
    </span>
  );
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

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-0.5 mt-3 px-3 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

export function SidebarNav({
  projects,
  unreadCount = 0,
  approvalsCount = 0,
}: {
  projects: SidebarProject[];
  unreadCount?: number;
  approvalsCount?: number;
}) {
  const pathname = usePathname();
  const projectMatch = pathname.match(/^\/projects\/([0-9a-f-]{36})(\/.*)?$/);
  const currentProject = projectMatch
    ? projects.find((p) => p.id === projectMatch[1])
    : undefined;
  const subPath = projectMatch?.[2] ?? "";

  const onSystemPage = SYSTEM_LINKS.some((l) => pathname.startsWith(l.href));
  // The active page must never be hidden, so a System page forces the group
  // open; otherwise the operator's last choice (persisted) wins.
  const [systemOpen, setSystemOpen] = useState(onSystemPage);
  useEffect(() => {
    if (onSystemPage) {
      setSystemOpen(true);
      return;
    }
    setSystemOpen(window.localStorage.getItem(SYSTEM_OPEN_KEY) === "1");
  }, [onSystemPage]);
  const toggleSystem = () => {
    const next = !systemOpen;
    setSystemOpen(next);
    window.localStorage.setItem(SYSTEM_OPEN_KEY, next ? "1" : "0");
  };

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
        {PROJECT_NAV_GROUPS.map((group, groupIndex) => (
          <div key={group.label ?? `group-${groupIndex}`}>
            {group.label && <GroupLabel>{group.label}</GroupLabel>}
            <ul className="space-y-0.5">
              {group.paths.map((path) => {
                const section = sectionFor(path);
                if (!section) return null;
                const tabSet = tabSetFor(path);
                const label = tabSet?.label ?? section.label;
                // A tab-set entry is "here" on any of its member routes.
                const memberPaths = tabSet?.paths ?? [path];
                const active =
                  path === ""
                    ? subPath === "" || subPath === "/"
                    : memberPaths.some((p) => subPath.startsWith(p));
                const Icon = section.icon;
                return (
                  <li key={path || "dashboard"}>
                    <NavLink
                      href={`/projects/${currentProject.id}${path}`}
                      active={active}
                    >
                      <Icon className="size-4" /> {label}
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    );
  }

  return (
    <nav className="flex-1 overflow-y-auto p-2">
      <ul className="space-y-0.5">
        <li>
          <NavLink href="/" active={pathname === "/"}>
            <LayoutDashboard className="size-4" /> Today
            <Badge count={unreadCount} />
          </NavLink>
        </li>
        <li>
          <NavLink href="/approvals" active={pathname.startsWith("/approvals")}>
            <CheckSquare className="size-4" /> Approvals
            <Badge count={approvalsCount} />
          </NavLink>
        </li>
        <li>
          <NavLink href="/work" active={pathname.startsWith("/work")}>
            <ListTodo className="size-4" /> Work
          </NavLink>
        </li>
        <li>
          <NavLink href="/projects" active={pathname.startsWith("/projects")}>
            <Users className="size-4" /> Clients
          </NavLink>
        </li>
        <li>
          <NavLink href="/prospects" active={pathname.startsWith("/prospects")}>
            <Crosshair className="size-4" /> Prospects
          </NavLink>
        </li>
      </ul>

      {projects.length > 0 && (
        <div className="mt-3">
          <GroupLabel>Active clients</GroupLabel>
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

      <div className="mt-3 border-t pt-2">
        <button
          type="button"
          onClick={toggleSystem}
          className="flex w-full items-center gap-1 rounded-md px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          <ChevronRight
            className={cn("size-3 transition-transform", systemOpen && "rotate-90")}
          />
          System
        </button>
        {systemOpen && (
          <ul className="space-y-0.5">
            {SYSTEM_LINKS.map((link) => {
              const Icon = link.icon;
              return (
                <li key={link.href}>
                  <NavLink href={link.href} active={pathname.startsWith(link.href)}>
                    <Icon className="size-4" /> {link.label}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </nav>
  );
}
