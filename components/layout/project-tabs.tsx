/**
 * Tab bar for a TAB_SETS entry (spec 037) — server-renderable wrapper that
 * resolves the set's routes and labels; PageTabs does the client-side
 * active-state work. `counts` keys are section paths (e.g. "/review").
 */
import { PageTabs } from "@/components/layout/page-tabs";
import { sectionFor, TAB_SETS } from "@/components/layout/sections";

export function ProjectTabs({
  projectId,
  setKey,
  counts = {},
}: {
  projectId: string;
  setKey: string;
  counts?: Record<string, number>;
}) {
  const set = TAB_SETS.find((s) => s.key === setKey);
  if (!set) return null;
  return (
    <PageTabs
      tabs={set.paths.map((path) => ({
        href: `/projects/${projectId}${path}`,
        label: sectionFor(path)?.label ?? path,
        count: counts[path],
      }))}
    />
  );
}
