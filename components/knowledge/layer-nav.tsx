"use client";

import { PageTabs } from "@/components/layout/page-tabs";

/**
 * Sub-navigation for the knowledge compilation layer (specs 020-024),
 * rendered via the shared PageTabs bar (cleanup 2026-08-18 — this was the
 * one nav styled as pills instead of the underline every sibling uses).
 *
 * The order is the pipeline order — sources, claims, contradictions,
 * instructions, wiki, builds, packets — because that is the order an
 * operator traces a problem in: "why does this page say that?" walks
 * backwards along it.
 */
const SECTIONS = [
  { path: "", label: "Claims", exact: true },
  { path: "/sources", label: "Sources" },
  { path: "/contradictions", label: "Contradictions" },
  { path: "/instructions", label: "Instructions" },
  { path: "/wiki", label: "Wiki" },
  { path: "/builds", label: "Builds" },
  { path: "/packets", label: "Packets" },
  { path: "/maintenance", label: "Maintenance" },
] as const;

export function KnowledgeLayerNav({ projectId }: { projectId: string }) {
  const base = `/projects/${projectId}/knowledge`;
  return (
    <PageTabs
      tabs={SECTIONS.map((section) => ({
        href: `${base}${section.path}`,
        label: section.label,
        exact: "exact" in section ? section.exact : undefined,
      }))}
    />
  );
}
