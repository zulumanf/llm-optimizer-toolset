/**
 * Staging mirror (spec 141). Copies the immutable benchmark tables for a set
 * of projects from the production database into a local staging database so
 * revision-3 adjudication, the claims verifier and the dataset export can be
 * exercised end-to-end WITHOUT writing to production.
 *
 *   npx tsx scripts/staging-mirror.ts --to <staging url> [--projects "name1|name2"]
 *
 * Reads only. Inserts with `on conflict do nothing`, so re-runs are safe.
 * Columns that reference users are nulled (no user rows are copied). Rows
 * are moved as JSON (row_to_json → json_populate_recordset), which keeps
 * every column type intact without per-table code.
 */
import "dotenv/config";
import postgres from "postgres";

const TABLES_IN_FK_ORDER = [
  "markets",
  "projects",
  "prompt_sets",
  "prompts",
  "prompt_set_versions",
  "companies",
  "runs",
  "responses",
  "mentions",
  "response_citations",
  "sources",
] as const;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const from = process.env.DATABASE_URL;
  const to = arg("to");
  if (!from || !to) throw new Error("DATABASE_URL and --to are required");
  if (to === from) throw new Error("refusing: --to equals DATABASE_URL");
  const src = postgres(from, { max: 2 });
  const dst = postgres(to, { max: 2 });
  const projectFilter = arg("projects")?.split("|").map((s) => s.trim()).filter(Boolean);

  const projects = projectFilter
    ? await src`select id from projects where name in ${src(projectFilter)}`
    : await src`select distinct pr.id from projects pr join runs r on r.project_id = pr.id where r.status in ('completed','partial') and r.label not like 'QA%' and pr.name <> 'Parva Core'`;
  const pids = projects.map((p) => p.id as string);
  console.log(`projects: ${pids.length}`);

  // Any foreign key that points OUTSIDE the mirrored set (users, vertical
  // packs, launches…) is nulled: staging needs the benchmark rows, not the
  // operator graph around them. The one circular in-set key is handled below.
  const mirrored = new Set<string>(TABLES_IN_FK_ORDER);
  const fkCols = await src`
    select tc.table_name, kcu.column_name, ccu.table_name as ref_table
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name
    join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name
    where tc.constraint_type = 'FOREIGN KEY' and tc.table_name in ${src([...mirrored])}`;
  const nullCols = new Map<string, string[]>();
  // Self-references (responses.reused_from, companies.merged_into) are
  // inserted null and restored in a second pass once every row exists.
  const selfCols = new Map<string, string[]>();
  for (const r of fkCols) {
    if (r.ref_table === r.table_name) { selfCols.set(r.table_name as string, [...(selfCols.get(r.table_name as string) ?? []), r.column_name as string]); continue; }
    if (mirrored.has(r.ref_table as string)) continue;
    nullCols.set(r.table_name as string, [...(nullCols.get(r.table_name as string) ?? []), r.column_name as string]);
  }
  console.log(`nulled out-of-set foreign keys: ${[...nullCols].map(([t, c]) => `${t}(${c.join(",")})`).join(" ")}`);

  // Prompt sets a project's runs or baseline point at may belong to another
  // project (capture reuse, market packs): follow the references, not the owner.
  const setIds = src`
    select id from prompt_sets where project_id in ${src(pids)}
    union select baseline_prompt_set_id from projects where id in ${src(pids)} and baseline_prompt_set_id is not null
    union select v.prompt_set_id from prompt_set_versions v join runs r on r.prompt_set_version_id = v.id where r.project_id in ${src(pids)}`;
  const selectors: Record<(typeof TABLES_IN_FK_ORDER)[number], () => ReturnType<typeof src>> = {
    markets: () => src`select row_to_json(t) j from markets t`,
    projects: () => src`select row_to_json(t) j from projects t where t.id in ${src(pids)}`,
    prompt_sets: () => src`select row_to_json(t) j from prompt_sets t where t.id in (${setIds})`,
    prompts: () => src`select row_to_json(t) j from prompts t where t.prompt_set_id in (${setIds})`,
    prompt_set_versions: () => src`select row_to_json(t) j from prompt_set_versions t where t.prompt_set_id in (${setIds})`,
    companies: () => src`select row_to_json(t) j from companies t order by (t.merged_into is not null)`,
    runs: () => src`select row_to_json(t) j from runs t where t.project_id in ${src(pids)}`,
    responses: () => src`select row_to_json(t) j from responses t where t.run_id in (select id from runs where project_id in ${src(pids)})`,
    mentions: () => src`select row_to_json(t) j from mentions t where t.response_id in (select id from responses where run_id in (select id from runs where project_id in ${src(pids)})) order by t.revision`,
    response_citations: () => src`select row_to_json(t) j from response_citations t where t.response_id in (select id from responses where run_id in (select id from runs where project_id in ${src(pids)}))`,
    sources: () => src`select row_to_json(t) j from sources t where t.project_id is null or t.project_id in ${src(pids)}`,
  };

  // projects.subject_company_id ↔ companies.project_id and
  // projects.baseline_prompt_set_id ↔ prompt_sets.project_id are circular:
  // insert projects without those two references, restore each after its
  // target table has been inserted.
  const DEFERRED: Record<string, "companies" | "prompt_sets"> = { subject_company_id: "companies", baseline_prompt_set_id: "prompt_sets" };
  const deferred = new Map<string, { projectId: string; value: string }[]>();
  for (const table of TABLES_IN_FK_ORDER) {
    const rows = await selectors[table]();
    const strip = nullCols.get(table) ?? [];
    const selfRefs: { id: string; col: string; value: string }[] = [];
    const json = [...rows].map((r) => {
      const o = (r as { j: Record<string, unknown> }).j;
      for (const c of strip) o[c] = null;
      for (const c of selfCols.get(table) ?? []) {
        if (typeof o[c] === "string") { selfRefs.push({ id: o.id as string, col: c, value: o[c] as string }); o[c] = null; }
      }
      if (table === "projects") {
        for (const col of Object.keys(DEFERRED)) {
          if (typeof o[col] === "string") {
            deferred.set(col, [...(deferred.get(col) ?? []), { projectId: o.id as string, value: o[col] as string }]);
            o[col] = null;
          }
        }
      }
      return o;
    });
    let inserted = 0;
    const BATCH = 500;
    for (let i = 0; i < json.length; i += BATCH) {
      const chunk = JSON.stringify(json.slice(i, i + BATCH));
      const res = await dst.unsafe(
        `insert into ${table} select * from json_populate_recordset(null::${table}, $1::text::json) on conflict do nothing`,
        [chunk]
      );
      inserted += res.count;
    }
    // Immutable tables (responses, mentions) forbid UPDATE: their
    // self-references (responses.reused_from) stay null in staging — they
    // are capture-reuse provenance, not inputs to any count.
    const IMMUTABLE = new Set(["responses", "mentions"]);
    for (const ref of IMMUTABLE.has(table) ? [] : selfRefs) {
      await dst.unsafe(`update ${table} set ${ref.col} = $1 where id = $2 and ${ref.col} is null and exists (select 1 from ${table} where id = $1)`, [ref.value, ref.id]);
    }
    console.log(`${table}: ${json.length} source rows, ${inserted} inserted, ${selfRefs.length} self-references restored`);
    for (const [col, target] of Object.entries(DEFERRED)) {
      if (target !== table) continue;
      for (const d of deferred.get(col) ?? []) {
        await dst.unsafe(`update projects set ${col} = $1 where id = $2 and ${col} is null`, [d.value, d.projectId]);
      }
    }
  }
  await src.end();
  await dst.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
