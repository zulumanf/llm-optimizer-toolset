import { sql } from "@/db/client";
import type { ProviderConfig } from "@/lib/runs/cells";

export type RunStatus = "pending" | "running" | "partial" | "completed" | "failed";

export interface Run {
  id: string;
  projectId: string;
  promptSetVersionId: string;
  label: string;
  providers: ProviderConfig[];
  status: RunStatus;
  statusDetail: string | null;
  trigger: "manual" | "scheduled";
  startedBy: string | null;
  budgetUsd: string;
  costUsd: string;
  startedAt: Date;
  completedAt: Date | null;
}

export interface RunListItem extends Run {
  successCount: number;
  failedCount: number;
}

export interface ResponseCell {
  id: string;
  promptId: string;
  promptText: string;
  provider: string;
  model: string;
  repetition: number;
  responseText: string | null;
  refusal: boolean;
  latencyMs: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string;
  error: { kind: string; message: string } | null;
  requestedAt: Date;
}

export interface ResponseDetail extends ResponseCell {
  runId: string;
  rawPayload: unknown;
}

const RUN_COLUMNS = sql`id, project_id, prompt_set_version_id, label, providers,
  status, status_detail, trigger, started_by, budget_usd, cost_usd,
  started_at, completed_at`;

export async function getRun(runId: string): Promise<Run | null> {
  const rows = await sql<Run[]>`select ${RUN_COLUMNS} from runs where id = ${runId}`;
  return rows[0] ?? null;
}

export async function listRuns(projectId: string): Promise<RunListItem[]> {
  return sql<RunListItem[]>`
    select ${RUN_COLUMNS},
      (select count(*)::int from responses r
        where r.run_id = runs.id and r.error is null) as success_count,
      (select count(distinct (r.prompt_id, r.provider, r.model, r.repetition))::int
        from responses r
        where r.run_id = runs.id and r.error is not null
          and not exists (
            select 1 from responses ok
            where ok.run_id = r.run_id and ok.prompt_id = r.prompt_id
              and ok.provider = r.provider and ok.model = r.model
              and ok.repetition = r.repetition and ok.error is null
          )) as failed_count
    from runs
    where project_id = ${projectId}
    order by started_at desc
  `;
}

/** Latest attempt per cell (successes shadow earlier failures). */
export async function listRunCells(runId: string): Promise<ResponseCell[]> {
  return sql<ResponseCell[]>`
    select distinct on (prompt_id, provider, model, repetition)
      id, prompt_id, prompt_text, provider, model, repetition,
      response_text, refusal, latency_ms, tokens_in, tokens_out,
      cost_usd, error, requested_at
    from responses
    where run_id = ${runId}
    order by prompt_id, provider, model, repetition,
      (error is null) desc, requested_at desc
  `;
}

export async function getResponse(id: string): Promise<ResponseDetail | null> {
  const rows = await sql<ResponseDetail[]>`
    select id, run_id, prompt_id, prompt_text, provider, model, repetition,
      raw_payload, response_text, refusal, latency_ms, tokens_in, tokens_out,
      cost_usd, error, requested_at
    from responses where id = ${id}
  `;
  return rows[0] ?? null;
}

/** Keys of cells that already have a successful capture (idempotent resume). */
export async function successfulCellKeys(runId: string): Promise<Set<string>> {
  const rows = await sql`
    select prompt_id, provider, model, repetition from responses
    where run_id = ${runId} and error is null
  `;
  return new Set(
    rows.map((r) => `${r.promptId}|${r.provider}|${r.model}|${r.repetition}`)
  );
}

export async function runCostMicroUsd(runId: string): Promise<number> {
  const rows = await sql`
    select coalesce(sum(cost_usd), 0) as total from responses where run_id = ${runId}
  `;
  return Math.round(Number(rows[0]?.total ?? 0) * 1_000_000);
}
