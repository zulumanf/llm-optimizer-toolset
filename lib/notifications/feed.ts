/**
 * The one attention feed (spec 030). db/operations' SQL signals plus the
 * TS-computed movement events, merged here so the Today page and the
 * notification sync can never disagree about what needs attention.
 */
import {
  attentionFeed,
  type AgencyMetrics,
  type AttentionItem,
} from "@/db/operations";
import { movementForProject } from "@/lib/competitors/movement";

export async function combinedAttentionFeed(): Promise<{
  items: AttentionItem[];
  metrics: AgencyMetrics;
}> {
  const base = await attentionFeed();

  // One movement check per project that already appears in the portfolio.
  // Projects without two comparable scored runs return [] after two cheap
  // queries — acceptable at agency scale, revisit past ~50 clients.
  const projects = new Map<string, string>();
  for (const item of base.items) projects.set(item.projectId, item.projectName);
  const { sql } = await import("@/db/client");
  const active = await sql`
    select id, name from projects where status = 'active'
  `;
  for (const row of active) projects.set(row.id as string, row.name as string);

  const items = [...base.items];
  for (const [projectId, projectName] of projects) {
    const events = await movementForProject(projectId);
    for (const kind of ["competitor_overtake", "visibility_drop"] as const) {
      const matching = events.filter((e) => e.kind === kind);
      if (matching.length === 0) continue;
      items.push({
        projectId,
        projectName,
        kind,
        severity: "attention",
        count: matching.length,
        detail: matching.map((e) => e.detail).join(" · "),
        href: `/projects/${projectId}/competitors`,
      });
    }
  }

  return { items, metrics: base.metrics };
}
