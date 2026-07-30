"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Sub-navigation for the knowledge compilation layer (specs 020-024).
 *
 * The order is the pipeline order — sources, claims, contradictions,
 * instructions, wiki, builds, packets — because that is the order an operator
 * traces a problem in: "why does this page say that?" walks backwards along it.
 */
const SECTIONS = [
  { path: "", label: "Claims" },
  { path: "/sources", label: "Sources" },
  { path: "/contradictions", label: "Contradictions" },
  { path: "/instructions", label: "Instructions" },
  { path: "/wiki", label: "Wiki" },
  { path: "/builds", label: "Builds" },
  { path: "/packets", label: "Packets" },
] as const;

export function KnowledgeLayerNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/projects/${projectId}/knowledge`;

  return (
    <nav className="mb-6 flex flex-wrap gap-1 border-b pb-2">
      {SECTIONS.map((section) => {
        const href = `${base}${section.path}`;
        const active =
          section.path === "" ? pathname === base : pathname.startsWith(href);
        return (
          <Link
            key={section.path}
            href={href}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
              active
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
            )}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
