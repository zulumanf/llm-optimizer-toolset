"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { PROJECT_SECTIONS as SECTIONS } from "@/components/layout/sections";

interface Target {
  label: string;
  sublabel: string;
  href: string;
  keywords: string;
}

const GLOBAL: Target[] = [
  { label: "Today", sublabel: "Operations", href: "/", keywords: "today operations attention feed home" },
  { label: "Inbox", sublabel: "Operations", href: "/notifications", keywords: "inbox notifications alerts" },
  { label: "Control tower", sublabel: "Operations", href: "/control-tower", keywords: "control tower portfolio queue health capacity" },
  { label: "Approvals", sublabel: "Operations", href: "/approvals", keywords: "approvals inbox pending decisions approve reject" },
  { label: "Automation", sublabel: "Operations", href: "/automation", keywords: "automation workflows connectors triggers events outreach safety" },
  { label: "Connectors", sublabel: "Automation", href: "/automation/connectors", keywords: "connectors integrations health ga4 crm gmail" },
  { label: "Workflow library", sublabel: "Automation", href: "/automation/workflows", keywords: "workflow library templates automation graphs" },
  { label: "Workflows", sublabel: "Operations", href: "/workflows", keywords: "workflow runs engine graph" },
  { label: "Agents", sublabel: "Registry", href: "/agents", keywords: "agents registry missions models" },
  { label: "Clients", sublabel: "Operations", href: "/projects", keywords: "clients projects portfolio" },
  { label: "Companies", sublabel: "Registry", href: "/companies", keywords: "companies brands competitors registry" },
  { label: "Exclusivity", sublabel: "Operations", href: "/exclusivity", keywords: "exclusivity conflicts markets agreements" },
  { label: "Onboard a client", sublabel: "Operations", href: "/onboarding", keywords: "onboard new client add vertical pack" },
];


export function CommandPalette({
  projects,
}: {
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const targets = useMemo(() => {
    const clientTargets: Target[] = projects.flatMap((project) => [
      {
        label: project.name,
        sublabel: "Client",
        href: `/projects/${project.id}`,
        keywords: `${project.name} client dashboard`,
      },
      ...SECTIONS.filter((s) => s.path !== "").map((section) => ({
        label: `${project.name} → ${section.label}`,
        sublabel: section.label,
        href: `/projects/${project.id}${section.path}`,
        keywords: `${project.name} ${section.label}`,
      })),
    ]);
    return [...GLOBAL, ...clientTargets];
  }, [projects]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return targets.slice(0, 8);
    const terms = q.split(/\s+/);
    return targets
      .filter((t) => {
        const haystack = `${t.label} ${t.keywords}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .slice(0, 12);
  }, [query, targets]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setOpen((prev) => !prev);
        setQuery("");
        setActive(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="top-[20%] max-w-xl translate-y-0 gap-0 p-0">
        <DialogTitle className="sr-only">Search and navigate</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                const target = results[active];
                if (target) go(target.href);
              }
            }}
            placeholder="Jump to a client or section…"
            className="w-full bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {results.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              Nothing matches &ldquo;{query}&rdquo;.
            </p>
          ) : (
            results.map((target, index) => (
              <button
                key={target.href + target.label}
                type="button"
                onMouseEnter={() => setActive(index)}
                onClick={() => go(target.href)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${
                  index === active ? "bg-accent text-accent-foreground" : ""
                }`}
              >
                <span className="truncate">{target.label}</span>
                <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                  {target.sublabel}
                </span>
              </button>
            ))
          )}
        </div>
        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          ↑↓ to move · ↵ to open · ⌘K to close
        </p>
      </DialogContent>
    </Dialog>
  );
}
