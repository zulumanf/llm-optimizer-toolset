import { sql } from "@/db/client";

export interface InterventionListItem {
  id: string;
  title: string;
  shipped: string;
  baselineWeak: boolean;
  setName: string;
  version: number;
  baselines: number;
  posts: number;
}

/** Interventions for a project with baseline/post run counts — the same
 * shape the interventions page renders. */
export async function listInterventions(
  projectId: string
): Promise<InterventionListItem[]> {
  return sql<InterventionListItem[]>`
    select i.id, i.title, to_char(i.shipped_at, 'YYYY-MM-DD') as shipped,
      i.baseline_weak, s.name as set_name, v.version,
      (select count(*)::int from intervention_runs ir
        where ir.intervention_id = i.id and ir.role = 'baseline') as baselines,
      (select count(*)::int from intervention_runs ir
        where ir.intervention_id = i.id and ir.role = 'post') as posts
    from interventions i
    join prompt_set_versions v on v.id = i.prompt_set_version_id
    join prompt_sets s on s.id = v.prompt_set_id
    where i.project_id = ${projectId} and i.archived_at is null
    order by i.shipped_at desc
  `;
}
