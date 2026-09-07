/**
 * Constrained LLM reviewers (spec 132). Pattern: CANONICAL SERVICE → FACT PACK
 * → LLM REVIEW → ADVISORY RESULT → human gate. The reviewer sees only the
 * draft and the fact pack the portfolio assembler built; it cannot query the
 * database, cannot change the draft, cannot send anything. Its findings are
 * stored as P2 communication events for the founder to read.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import { modelForTask } from "@/lib/ai/routing";
import { AUTOMATION_PROMPTS } from "@/lib/automation/prompts";
import type { CommunicationFactPack } from "@/lib/engagements/qa";

export const REVIEW_KINDS = ["unsupported_claim", "causal_overclaim", "contradiction", "technical_language", "salesy"] as const;

export const reviewOutput = z.object({
  pass: z.boolean(),
  issues: z.array(
    z.object({
      kind: z.enum(REVIEW_KINDS).catch("unsupported_claim"),
      quote: z.string().max(400),
      why: z.string().max(600),
    })
  ),
});
export type ReviewOutput = z.infer<typeof reviewOutput>;

export interface ReviewResult {
  role: "COMMUNICATION_REVIEWER" | "EVIDENCE_REVIEWER";
  agentVersion: string;
  model: string;
  output: ReviewOutput | null;
  error: string | null;
}

export function serializeFactPack(pack: CommunicationFactPack): string {
  return [
    `Client: ${pack.clientName}`,
    `Market: ${pack.marketName}`,
    `Canonical counts (the ONLY numbers that may appear as "X of N"): ${pack.canonicalCounts.join("; ") || "none"}`,
    `Completed work: ${pack.doneTitles.join("; ") || "none"}`,
    `In progress: ${pack.inProgressTitles.join("; ") || "none"}`,
    `Blocked: ${pack.blockedTitles.join("; ") || "none"}`,
    `Awaiting client approval: ${pack.approvalTitles.join("; ") || "none"}`,
    `Next planned remeasurement: ${pack.nextMeasurementOn ?? "none"}`,
    `Engagement ends: ${pack.engagementEndsOn}`,
    `Attribution rule: movement in counts is observed, never attributed to the agency's work.`,
  ].join("\n");
}

const reviewSchema = z.object({
  engagementId: z.string().uuid(),
  draft: z.string().trim().min(20).max(20_000),
  role: z.enum(["COMMUNICATION_REVIEWER", "EVIDENCE_REVIEWER"]).default("COMMUNICATION_REVIEWER"),
});

/** Advisory review of a client-facing draft. Records issues (if any) as a P2
 * communication QA event; never mutates the draft, never sends. */
export async function reviewClientDraft(
  user: CurrentUser,
  raw: unknown,
  caller?: AgentCaller
): Promise<ActionResult<ReviewResult>> {
  const parsed = reviewSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const { portfolioClient } = await import("@/lib/engagements/portfolio");
    const [row] = await sql`select project_id from client_engagements where id = ${input.engagementId}`;
    if (!row) return fail(new ClassifiedError("not_found", "Engagement not found."));
    const client = await portfolioClient(row.projectId as string);
    if (!client) return fail(new ClassifiedError("not_found", "Engagement not found."));
    const key = input.role === "COMMUNICATION_REVIEWER" ? "client_communication_review" : "client_evidence_review";
    const prompt = AUTOMATION_PROMPTS[key];
    const model = modelForTask(key);
    let output: ReviewOutput | null = null;
    let error: string | null = null;
    try {
      const run = await runAgent({
        agentVersion: prompt.version,
        system: prompt.system,
        user: `${prompt.userPreamble}\n\nFACT PACK:\n${serializeFactPack(client.factPack)}\n\n${input.role === "COMMUNICATION_REVIEWER" ? "DRAFT" : "TEXT"}:\n${input.draft}`,
        schema: reviewOutput,
        model,
        projectId: row.projectId as string,
        purpose: key,
        caller,
      });
      output = run.output;
    } catch (err) {
      error = err instanceof Error ? err.message : "unknown";
    }
    await sql.begin(async (tx) => {
      const code = input.role === "COMMUNICATION_REVIEWER" ? "LLM_COMMUNICATION_REVIEW" : "LLM_EVIDENCE_REVIEW";
      const [open] = await tx`select id from engagement_qa_events where engagement_id = ${input.engagementId} and lane = 'communication' and code = ${code} and status = 'open'`;
      if (output && output.issues.length > 0) {
        const message = `${output.issues.length} advisory issue(s): ${output.issues.map((i) => `${i.kind}: "${i.quote.slice(0, 80)}"`).join("; ")}`;
        if (open) await tx`update engagement_qa_events set last_seen_at = now(), message = ${message}, detail = ${tx.json(output as never)} where id = ${open.id}`;
        else await tx`insert into engagement_qa_events (engagement_id, project_id, lane, code, severity, message, detail) values (${input.engagementId}, ${row.projectId}, 'communication', ${code}, 'P2', ${message}, ${tx.json(output as never)})`;
      } else if (open && output?.pass) {
        await tx`update engagement_qa_events set status = 'resolved', resolved_at = now() where id = ${open.id}`;
      }
      await writeAudit(tx, { userId: user.id, action: "engagement.llm_review", entity: "client_engagement", entityId: input.engagementId, projectId: row.projectId as string, detail: { role: input.role, issues: output?.issues.length ?? null, failed: error !== null, model } });
    });
    return ok({ role: input.role, agentVersion: prompt.version, model, output, error });
  } catch (err) {
    return fail(err);
  }
}
