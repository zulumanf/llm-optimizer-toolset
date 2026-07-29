/**
 * Whole-platform snapshot pieces (spec 016): program activity and the
 * category-ownership map. Both are built from stored rows and embedded in
 * the immutable report body, so a published report never depends on live
 * tables (docs/03) — renaming a company or dismissing a finding later
 * changes nothing in what the client received.
 */
import { sql } from "@/db/client";
import { getSubjectCompany } from "@/db/companies";
import type { FrozenPrompt } from "@/lib/prompts/types";
import type {
  SnapshotProgram,
  SnapshotCategoryOwnership,
} from "@/lib/reports/types";

export async function buildProgram(args: {
  projectId: string;
  periodStart: string;
  periodEnd: string;
}): Promise<SnapshotProgram> {
  const { projectId, periodStart, periodEnd } = args;
  const within = (column: string) =>
    sql.unsafe(
      `${column} >= '${periodStart}'::date and ${column} < ('${periodEnd}'::date + 1)`
    );

  const [gapRows, accuracyRows, interventionRows, taskRows, contentRows] =
    await Promise.all([
      sql`
        select id, gap_type, finding, opportunity_score, status
        from gap_findings
        where project_id = ${projectId} and ${within("created_at")}
        order by opportunity_score desc limit 20
      `,
      sql`
        select id, kind, severity, quote, status
        from accuracy_findings
        where project_id = ${projectId} and ${within("created_at")}
        order by case severity when 'high' then 0 when 'medium' then 1 else 2 end,
          created_at desc
        limit 20
      `,
      sql`
        select i.id, i.title, to_char(i.shipped_at, 'YYYY-MM-DD') as shipped_at,
          (select count(*)::int from intervention_runs ir
            where ir.intervention_id = i.id and ir.role = 'post') as measured
        from interventions i
        where i.project_id = ${projectId}
          and (${within("i.shipped_at")} or ${within("i.created_at")})
        order by i.shipped_at desc limit 20
      `,
      sql`
        select id, title, priority from tasks
        where project_id = ${projectId} and status = 'done'
          and ${within("updated_at")}
        order by updated_at desc limit 20
      `,
      sql`
        select id, title, published_url from content_assets
        where project_id = ${projectId} and status = 'published'
          and ${within("updated_at")}
        order by updated_at desc limit 20
      `,
    ]);

  return {
    gapFindings: gapRows.map((g) => ({
      findingId: g.id as string,
      gapType: g.gapType as string,
      finding: g.finding as string,
      opportunityScore: Number(g.opportunityScore),
      status: g.status as string,
    })),
    accuracyFindings: accuracyRows.map((a) => ({
      accuracyId: a.id as string,
      kind: a.kind as string,
      severity: a.severity as string,
      quote: (a.quote as string).slice(0, 300),
      status: a.status as string,
    })),
    interventions: interventionRows.map((i) => ({
      interventionId: i.id as string,
      title: i.title as string,
      shippedAt: i.shippedAt as string,
      // Verdicts are computed on read (spec 007) — the report records how
      // many post-runs exist, not a re-derived verdict, to stay honest
      // about what was measured at publication time.
      measuredVerdicts: (i.measured as number) ?? 0,
      notableVerdicts: 0,
    })),
    tasksCompleted: taskRows.map((t) => ({
      taskId: t.id as string,
      title: t.title as string,
      priority: t.priority as string,
    })),
    contentPublished: contentRows.map((c) => ({
      assetId: c.id as string,
      title: c.title as string,
      url: (c.publishedUrl as string | null) ?? null,
    })),
  };
}

/**
 * Category ownership for the report's current run. Labels are derived
 * deterministically from counts, and every row carries its
 * numerator/denominator so a label can never stand alone (spec 016).
 */
export async function buildCategoryOwnership(args: {
  projectId: string;
  runId: string;
  promptSetVersionId: string;
}): Promise<SnapshotCategoryOwnership[]> {
  const subject = await getSubjectCompany(args.projectId);
  if (!subject) return [];

  const [version] = await sql`
    select frozen_prompts from prompt_set_versions
    where id = ${args.promptSetVersionId}
  `;
  const categoryByPrompt = new Map<string, string>();
  for (const prompt of (version?.frozenPrompts as FrozenPrompt[] | null) ?? []) {
    if (!prompt.isHoldout) categoryByPrompt.set(prompt.promptId, prompt.category);
  }
  if (categoryByPrompt.size === 0) return [];

  const rows = await sql`
    select r.id as response_id, r.prompt_id, m.company_id, c.name,
      m.mentioned, m.recommended
    from responses r
    left join mentions m on m.response_id = r.id and m.mentioned
      and not exists (select 1 from mentions n
        where n.response_id = m.response_id and n.company_id = m.company_id
          and n.revision > m.revision)
    left join companies c on c.id = m.company_id
    where r.run_id = ${args.runId} and r.error is null
  `;

  interface Bucket {
    observations: Set<string>;
    mentions: number;
    recommendations: number;
    competitorMentions: Map<string, number>;
  }
  const buckets = new Map<string, Bucket>();
  for (const row of rows) {
    const category = categoryByPrompt.get(row.promptId as string);
    if (!category) continue; // holdout or unknown — excluded like everywhere
    if (!buckets.has(category)) {
      buckets.set(category, {
        observations: new Set(),
        mentions: 0,
        recommendations: 0,
        competitorMentions: new Map(),
      });
    }
    const bucket = buckets.get(category)!;
    bucket.observations.add(row.responseId as string);
    if (!row.companyId) continue;
    if (row.companyId === subject.id) {
      bucket.mentions += 1;
      if (row.recommended) bucket.recommendations += 1;
    } else {
      const name = (row.name as string) ?? "unknown";
      bucket.competitorMentions.set(
        name,
        (bucket.competitorMentions.get(name) ?? 0) + 1
      );
    }
  }

  return [...buckets.entries()]
    .map(([category, bucket]) => {
      const observations = bucket.observations.size;
      const mentionRate = observations > 0 ? bucket.mentions / observations : 0;
      const recRate = observations > 0 ? bucket.recommendations / observations : 0;
      const [leader, leaderCount] = [...bucket.competitorMentions.entries()].sort(
        (a, b) => b[1] - a[1]
      )[0] ?? [null, 0];

      let label: SnapshotCategoryOwnership["label"];
      if (bucket.mentions === 0) label = "absent";
      else if (recRate >= 0.5) label = "owned";
      else if (mentionRate >= 0.25) label = "emerging";
      else label = "contested";

      return {
        category,
        label,
        observations,
        mentions: bucket.mentions,
        recommendations: bucket.recommendations,
        leadingCompetitor: leader,
        leadingCompetitorMentions: leaderCount,
      };
    })
    .sort((a, b) => b.observations - a.observations);
}
