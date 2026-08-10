/**
 * LLM call ledger (spec 050). Every runAgent call — success or terminal
 * failure — writes one row here, so agent spend is visible to the daily
 * ceiling (db/runs.ts spendLast24hUsd) and to per-client rollups instead of
 * being computed and discarded.
 *
 * The write must never fail the agent call it records: a ledger outage is
 * an observability incident, not a reason to lose a classification. Failure
 * is logged loudly and swallowed.
 */
import { sql } from "@/db/client";
import { log } from "@/lib/logger";

export interface LlmCallRecord {
  agentVersion: string;
  model: string;
  purpose?: string | null;
  projectId?: string | null;
  tokensIn: number;
  tokensOut: number;
  costMicroUsd: number;
  attempts: number;
  success: boolean;
}

export async function recordLlmCall(record: LlmCallRecord): Promise<void> {
  try {
    await sql`
      insert into llm_calls
        (agent_version, model, purpose, project_id, tokens_in, tokens_out,
         cost_micro_usd, attempts, success)
      values
        (${record.agentVersion}, ${record.model}, ${record.purpose ?? null},
         ${record.projectId ?? null}, ${record.tokensIn}, ${record.tokensOut},
         ${Math.round(record.costMicroUsd)}, ${record.attempts},
         ${record.success})
    `;
  } catch (err) {
    log("error", "llm_ledger.write_failed", {
      agent: record.agentVersion,
      costMicroUsd: record.costMicroUsd,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}
