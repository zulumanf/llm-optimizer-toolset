/**
 * Prompt suggestions (spec 087): propose the market-pack combinations the
 * active set does not monitor yet, staged for human review — never inserted
 * into measurement directly. Deterministic (same pack + same set → identical
 * proposals); the origin vocabulary also admits 'observed' rows transcribed
 * from real user questions.
 *
 * Answers one question: are we monitoring the buyer/seller decision space
 * that actually matters? Approval materializes through the normal prompt
 * path (addPrompt) with source = origin, so provenance and dimensions land
 * on the prompts row and survive the freeze.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { addPrompt } from "@/lib/prompts/prompt-service";
import { expandMarketPack } from "@/lib/markets/generate";
import { getMarketPack } from "@/lib/markets/packs";
import { decideStagedRow } from "@/lib/research/decisions";
import { firstZodMessage } from "@/lib/service-helpers";

export const PROMPT_SUGGESTION_VERSION = "prompt-suggest-v1+deterministic";

/** Per-call staging cap — the review queue must stay reviewable. Skipped
 * counts are reported, never silent (the expansion convention). */
export const MAX_PROMPT_SUGGESTIONS = 30;

export interface PromptSuggestion {
  id: string;
  projectId: string;
  promptSetId: string;
  text: string;
  category: string;
  tier: number | null;
  audience: string | null;
  priceTier: string | null;
  neighborhood: string | null;
  building: string | null;
  propertyType: string | null;
  templateRef: string | null;
  origin: "generated" | "observed";
  rationale: string;
  evidence: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "superseded";
  generatorVersion: string;
  promotedPromptId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}

const SUGGESTION_COLUMNS = sql`id, project_id, prompt_set_id, text, category,
  tier, audience, price_tier, neighborhood, building, property_type,
  template_ref, origin, rationale, evidence, status, generator_version,
  promoted_prompt_id, created_at, decided_at`;

export interface SuggestionReport {
  staged: number;
  skippedExisting: number;
  skippedByCap: number;
}

/**
 * Stage the pack combinations missing from the set. Dedupes case-insensitively
 * against active prompts AND pending suggestions; re-running after decisions
 * proposes only what is still uncovered.
 */
export async function generatePromptSuggestions(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<SuggestionReport>> {
  const parsed = z
    .object({
      setId: z.string().uuid(),
      packKey: z.string().min(1),
      templateKeys: z.array(z.string()).optional(),
      neighborhoods: z.array(z.string()).optional(),
      cap: z.number().int().positive().max(100).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  const pack = getMarketPack(input.packKey);
  if (!pack) {
    return fail(new ClassifiedError("not_found", `Unknown market pack "${input.packKey}".`));
  }
  try {
    assertCanWrite(user);
    const [set] = await sql`
      select project_id, archived_at from prompt_sets where id = ${input.setId}
    `;
    if (!set) return fail(new ClassifiedError("not_found", "Prompt set not found."));
    if (set.archivedAt) {
      return fail(new ClassifiedError("conflict", "Archived sets cannot take suggestions."));
    }

    // Expand everything the pack can produce; the suggestion cap (not the
    // expansion cap) decides how many reach the review queue per call.
    const expansion = expandMarketPack(pack, {
      templateKeys: input.templateKeys,
      neighborhoods: input.neighborhoods,
      cap: 200,
    });
    const existing = await sql`
      select lower(text) as text from prompts
      where prompt_set_id = ${input.setId} and archived_at is null
      union
      select lower(text) as text from prompt_suggestions
      where prompt_set_id = ${input.setId} and status = 'pending'
    `;
    const seen = new Set(existing.map((r) => r.text as string));
    const cap = input.cap ?? MAX_PROMPT_SUGGESTIONS;

    let staged = 0;
    let skippedExisting = 0;
    let skippedByCap = 0;
    await sql.begin(async (tx) => {
      for (const prompt of expansion.prompts) {
        const key = prompt.text.toLowerCase();
        if (seen.has(key)) {
          skippedExisting += 1;
          continue;
        }
        if (staged >= cap) {
          skippedByCap += 1;
          continue;
        }
        await tx`
          insert into prompt_suggestions
            (project_id, prompt_set_id, text, category, tier, audience,
             price_tier, neighborhood, property_type, template_ref, origin,
             rationale, evidence, generator_version, created_by)
          values
            (${set.projectId}, ${input.setId}, ${prompt.text},
             ${prompt.category}, ${prompt.tier}, ${prompt.audience},
             ${prompt.priceTier}, ${prompt.neighborhood},
             ${prompt.propertyType}, ${prompt.templateRef}, 'generated',
             ${`Market pack combination not yet monitored (${prompt.templateRef}).`},
             ${tx.json({ packKey: pack.key, packVersion: pack.version })},
             ${PROMPT_SUGGESTION_VERSION}, ${user.id})
          on conflict (prompt_set_id, md5(lower(text))) where status = 'pending'
            do nothing
        `;
        seen.add(key);
        staged += 1;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "prompt_suggestion.generate",
        entity: "prompt_set",
        entityId: input.setId,
        detail: {
          packKey: pack.key,
          staged,
          skippedExisting,
          skippedByCap: skippedByCap + expansion.skippedByCap,
        },
      });
    });
    return ok({
      staged,
      skippedExisting,
      skippedByCap: skippedByCap + expansion.skippedByCap,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function listPromptSuggestions(
  setId: string,
  status: PromptSuggestion["status"] = "pending"
): Promise<PromptSuggestion[]> {
  return sql<PromptSuggestion[]>`
    select ${SUGGESTION_COLUMNS} from prompt_suggestions
    where prompt_set_id = ${setId} and status = ${status}
    order by created_at asc, text asc
  `;
}

/** Approve: materialize through addPrompt (provenance = origin, dimensions
 * carried), then decide the row and record the promoted prompt. The
 * materialize-then-decide order is the enrichment pattern — an approval that
 * fails to materialize leaves the suggestion pending, never half-done. */
export async function approvePromptSuggestion(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ suggestionId: string; promptId: string }>> {
  const parsed = z.object({ suggestionId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid suggestion id."));
  }
  try {
    assertCanWrite(user);
    const [suggestion] = await sql<PromptSuggestion[]>`
      select ${SUGGESTION_COLUMNS} from prompt_suggestions
      where id = ${parsed.data.suggestionId}
    `;
    if (!suggestion) {
      return fail(new ClassifiedError("not_found", "Suggestion not found."));
    }
    if (suggestion.status !== "pending") {
      return fail(
        new ClassifiedError("conflict", `Suggestion is already ${suggestion.status}.`)
      );
    }

    const added = await addPrompt(user, {
      setId: suggestion.promptSetId,
      text: suggestion.text,
      category: suggestion.category,
      tier: suggestion.tier ?? undefined,
      source: suggestion.origin,
      audience: suggestion.audience ?? undefined,
      priceTier: suggestion.priceTier ?? undefined,
      templateRef: suggestion.templateRef ?? undefined,
      neighborhood: suggestion.neighborhood ?? undefined,
      building: suggestion.building ?? undefined,
      propertyType: suggestion.propertyType ?? undefined,
    });
    if (!added.ok) return fail(added.error);

    await decideStagedRow({
      table: "prompt_suggestions",
      id: suggestion.id,
      user,
      to: "approved",
      auditAction: "prompt_suggestion.approve",
      auditEntity: "prompt_suggestion",
      auditDetail: { setId: suggestion.promptSetId, promptId: added.data.id },
    });
    await sql`
      update prompt_suggestions set promoted_prompt_id = ${added.data.id}
      where id = ${suggestion.id}
    `;
    return ok({ suggestionId: suggestion.id, promptId: added.data.id });
  } catch (err) {
    return fail(err);
  }
}

export async function rejectPromptSuggestion(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ suggestionId: string }>> {
  const parsed = z.object({ suggestionId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid suggestion id."));
  }
  try {
    assertCanWrite(user);
    await decideStagedRow({
      table: "prompt_suggestions",
      id: parsed.data.suggestionId,
      user,
      to: "rejected",
      auditAction: "prompt_suggestion.reject",
      auditEntity: "prompt_suggestion",
      auditDetail: {},
    });
    return ok({ suggestionId: parsed.data.suggestionId });
  } catch (err) {
    return fail(err);
  }
}
