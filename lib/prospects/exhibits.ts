/**
 * Live example chats (spec 045 Tier 2): consumer-app share links created
 * manually by an operator, attached as exhibits. Only allowlisted share
 * domains ever land on a prospect-facing page — the exhibit's whole value
 * is that it lives on the assistant vendor's own domain, beyond our edit.
 *
 * Exhibits corroborate; the sampled API benchmark measures. The audit page
 * says exactly that.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";

/** Share-URL prefixes that may render on a prospect page. Nothing else. */
export const EXHIBIT_URL_ALLOWLIST: { prefix: string; assistant: "chatgpt" | "perplexity" }[] = [
  { prefix: "https://chatgpt.com/share/", assistant: "chatgpt" },
  { prefix: "https://chat.openai.com/share/", assistant: "chatgpt" },
  { prefix: "https://www.perplexity.ai/search/", assistant: "perplexity" },
  { prefix: "https://perplexity.ai/search/", assistant: "perplexity" },
];

export function exhibitAssistantFor(url: string): "chatgpt" | "perplexity" | null {
  const match = EXHIBIT_URL_ALLOWLIST.find((entry) => url.startsWith(entry.prefix));
  return match?.assistant ?? null;
}

const exhibitSchema = z.object({
  prospectId: z.string().uuid(),
  url: z
    .string()
    .trim()
    .url()
    .max(500)
    .refine((u) => exhibitAssistantFor(u) !== null, {
      message:
        "Only ChatGPT share links (chatgpt.com/share/…) or Perplexity threads (perplexity.ai/search/…) can be attached — the exhibit must live on the assistant's own domain.",
    }),
  question: z.string().trim().min(1).max(500),
  capturedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(1000).optional(),
});

export interface ExhibitRow {
  id: string;
  url: string;
  assistant: "chatgpt" | "perplexity";
  question: string;
  capturedOn: string;
  notes: string | null;
}

export async function addExhibit(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ exhibitId: string }>> {
  const parsed = exhibitSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const assistant = exhibitAssistantFor(input.url)!;
    const exhibitId = await sql.begin(async (tx) => {
      const [prospect] = await tx`
        select id from prospects where id = ${input.prospectId} and archived_at is null
      `;
      if (!prospect) throw new ClassifiedError("not_found", "Prospect not found.");
      const [row] = await tx`
        insert into prospect_exhibits
          (prospect_id, url, assistant, question, captured_on, notes, created_by)
        values (${input.prospectId}, ${input.url}, ${assistant}, ${input.question},
          ${input.capturedOn}, ${input.notes ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.exhibit_add",
        entity: "prospect_exhibit",
        entityId: row?.id as string,
        detail: { prospectId: input.prospectId, assistant, url: input.url },
      });
      await tx`
        insert into prospect_activities (prospect_id, kind, detail, actor_id)
        values (${input.prospectId}, 'exhibit_added',
          ${tx.json({ assistant, question: input.question } as never)}, ${user.id})
      `;
      return row?.id as string;
    });
    return ok({ exhibitId });
  } catch (err) {
    return fail(err);
  }
}

export async function archiveExhibit(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ exhibitId: string }>> {
  const parsed = z.object({ exhibitId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid exhibit id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update prospect_exhibits set archived_at = now()
        where id = ${parsed.data.exhibitId} and archived_at is null
        returning id, prospect_id
      `;
      if (!row) throw new ClassifiedError("not_found", "Exhibit not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.exhibit_archive",
        entity: "prospect_exhibit",
        entityId: row.id as string,
        detail: { prospectId: row.prospectId },
      });
    });
    return ok({ exhibitId: parsed.data.exhibitId });
  } catch (err) {
    return fail(err);
  }
}

export async function listExhibits(prospectId: string): Promise<ExhibitRow[]> {
  const rows = await sql`
    select id, url, assistant, question, captured_on::text, notes
    from prospect_exhibits
    where prospect_id = ${prospectId} and archived_at is null
    order by captured_on desc, created_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    url: r.url as string,
    assistant: r.assistant as "chatgpt" | "perplexity",
    question: r.question as string,
    capturedOn: r.capturedOn as string,
    notes: (r.notes as string | null) ?? null,
  }));
}
