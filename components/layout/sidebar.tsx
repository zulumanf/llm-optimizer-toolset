import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { listActiveProjects } from "@/db/projects";
import { cn } from "@/lib/utils";

// Sections beyond Projects arrive with specs/002+ (docs/04 navigation)
const UPCOMING_SECTIONS = [
  "Dashboard",
  "Prompts",
  "Runs",
  "Review",
  "Competitors",
  "Reports",
  "Tasks",
] as const;

export async function Sidebar(): Promise<React.ReactElement> {
  const projects = await listActiveProjects();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r bg-card">
      <div className="border-b p-4">
        <p className="text-sm font-semibold">LLM Optimizer</p>
        <p className="text-xs text-muted-foreground">Parva · internal</p>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        <Link
          href="/projects"
          className={cn(
            "flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium",
            "bg-accent text-accent-foreground"
          )}
        >
          <FolderKanban className="size-4" />
          Projects
        </Link>
        <ul className="mt-1">
          {UPCOMING_SECTIONS.map((label) => (
            <li
              key={label}
              className="cursor-default px-3 py-2 text-sm text-muted-foreground/50"
              title="Arrives with a later spec"
            >
              {label}
            </li>
          ))}
        </ul>
        {projects.length > 0 && (
          <div className="mt-4 border-t pt-3">
            <p className="px-3 pb-1 text-xs font-medium uppercase text-muted-foreground">
              Active projects
            </p>
            <ul>
              {projects.map((p) => (
                <li key={p.id}>
                  <Link
                    href={`/projects/${p.id}`}
                    className="block truncate rounded-md px-3 py-1.5 text-sm hover:bg-accent"
                  >
                    {p.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>
    </aside>
  );
}
