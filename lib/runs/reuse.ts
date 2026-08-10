/**
 * Capture reuse (spec 054). The eligibility rules live in exactly one
 * query: byte-identical prompt, same provider+model, an ORIGINAL capture
 * (never a copy — provenance always points at the source that was paid
 * for), no error, recognized shape, from a DIFFERENT project, younger
 * than the reuse window, repetition-aligned so resume stays idempotent.
 *
 * Mock never participates: test and demo behavior is a contract other
 * suites rely on, and the mock costs nothing to call anyway.
 */
import { sql } from "@/db/client";
import { CAPTURE_REUSE_WINDOW_HOURS } from "@/lib/constants";
import type { Cell } from "@/lib/runs/cells";

export interface ReusableCapture {
  id: string;
  rawPayload: unknown;
  responseText: string | null;
  refusal: boolean;
  tokensIn: number | null;
  tokensOut: number | null;
  requestParams: unknown;
  shapeRecognized: boolean | null;
}

export async function findReusableCapture(
  cell: Cell,
  projectId: string
): Promise<ReusableCapture | null> {
  if (cell.provider === "mock") return null;
  const rows = await sql`
    select r.id, r.raw_payload, r.response_text, r.refusal, r.tokens_in,
      r.tokens_out, r.request_params, r.shape_recognized
    from responses r
    join runs source_run on source_run.id = r.run_id
    where md5(r.prompt_text) = md5(${cell.promptText})
      and r.prompt_text = ${cell.promptText}
      and r.provider = ${cell.provider}
      and r.model = ${cell.model}
      and r.repetition = ${cell.repetition}
      and r.error is null
      and r.reused_from is null
      and r.shape_recognized is not false
      and source_run.project_id != ${projectId}
      and r.requested_at > now() - make_interval(hours => ${CAPTURE_REUSE_WINDOW_HOURS})
    order by r.requested_at desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id as string,
    rawPayload: row.rawPayload,
    responseText: (row.responseText as string | null) ?? null,
    refusal: Boolean(row.refusal),
    tokensIn: (row.tokensIn as number | null) ?? null,
    tokensOut: (row.tokensOut as number | null) ?? null,
    requestParams: row.requestParams,
    shapeRecognized: (row.shapeRecognized as boolean | null) ?? null,
  };
}
