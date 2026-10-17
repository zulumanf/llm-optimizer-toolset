/**
 * Real-capture classifier validation (spec 151 A11).
 *
 * 1. `createGoldSample` draws a seeded, stratified sample of (response,
 *    company) pairs from REAL captured answers that carry a classifier-class
 *    judgment (stratum = provider × classifier label), excluding mock data.
 * 2. Staff annotate BLIND — `nextItemForAnnotator` never returns the
 *    classifier's label.
 * 3. Disagreements are adjudicated by a person (`adjudicateItem`).
 * 4. `goldReport` computes precision/recall over unanimous/adjudicated pairs
 *    only, with Wilson intervals and Cohen's kappa.
 *
 * Usage rights: the sample reads answers RF captured through provider APIs
 * for its own measurement; annotations are internal and never published.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { CURRENT_REVISION } from "@/db/mentions";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { PARSER_VERSION_ADJUDICATION, PARSER_VERSION_LLM } from "@/lib/constants";
import { seededRandom } from "@/lib/stats";
import {
  cohensKappa,
  fieldReport,
  seededShuffle,
  type FieldReport,
  type HumanLabel,
  type PairEvidence,
} from "@/lib/evaluation/metrics";

/** The classifier floors the gold set is judged against (lib/accuracy/classifier-eval.ts). */
export const GOLD_MIN_SAMPLE = 20;
export const GOLD_MAX_SAMPLE = 1000;

const sampleSchema = z.object({
  name: z.string().trim().min(3).max(120),
  size: z.number().int().min(GOLD_MIN_SAMPLE).max(GOLD_MAX_SAMPLE),
  seed: z.number().int().min(0).max(2 ** 31 - 1),
  projectId: z.string().uuid().optional(),
});

interface Candidate {
  responseId: string;
  companyId: string;
  stratum: string;
}

export async function createGoldSample(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ sampleId: string; size: number; strata: Record<string, number> }>> {
  const parsed = sampleSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const rows = await sql`
      select m.response_id, m.company_id, r.provider,
        case when m.recommended then 'recommended' when m.mentioned then 'mentioned_only' else 'rejected' end as label
      from mentions m
      join responses r on r.id = m.response_id
      join runs run on run.id = r.run_id
      where ${CURRENT_REVISION}
        and (m.parser_version in (${PARSER_VERSION_LLM}, ${PARSER_VERSION_ADJUDICATION}) or m.reviewed_by is not null)
        and r.error is null and r.provider <> 'mock'
        and (${input.projectId ?? null}::uuid is null or run.project_id = ${input.projectId ?? null})
      order by m.response_id, m.company_id
    `;
    const byStratum = new Map<string, Candidate[]>();
    for (const r of rows) {
      const stratum = `${r.provider as string}:${r.label as string}`;
      const list = byStratum.get(stratum) ?? [];
      list.push({ responseId: r.responseId as string, companyId: r.companyId as string, stratum });
      byStratum.set(stratum, list);
    }
    if (byStratum.size === 0) {
      return fail(new ClassifiedError("conflict", "No classified real answers to sample yet."));
    }
    // Equal allocation across strata (hard negatives and positives both get
    // seen), topped up from larger strata when a small one runs out.
    const rand = seededRandom(input.seed);
    const strataNames = [...byStratum.keys()].sort();
    const shuffled = new Map(strataNames.map((s) => [s, seededShuffle(byStratum.get(s) ?? [], rand)]));
    const picked: Candidate[] = [];
    const perStratum = Math.ceil(input.size / strataNames.length);
    for (const s of strataNames) picked.push(...(shuffled.get(s) ?? []).slice(0, perStratum));
    if (picked.length < input.size) {
      const rest = strataNames.flatMap((s) => (shuffled.get(s) ?? []).slice(perStratum));
      picked.push(...rest.slice(0, input.size - picked.length));
    }
    const final = seededShuffle(picked.slice(0, input.size), rand);
    const strata: Record<string, number> = {};
    for (const c of final) strata[c.stratum] = (strata[c.stratum] ?? 0) + 1;

    const sampleId = await sql.begin(async (tx) => {
      const [sample] = await tx`
        insert into gold_samples (name, seed, target_size, strata, created_by)
        values (${input.name}, ${input.seed}, ${input.size}, ${tx.json(strata)}, ${user.id})
        returning id
      `;
      for (const [position, c] of final.entries()) {
        await tx`
          insert into gold_sample_items (sample_id, response_id, company_id, stratum, position)
          values (${sample!.id}, ${c.responseId}, ${c.companyId}, ${c.stratum}, ${position})
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "evaluation.gold_sample_created",
        entity: "gold_sample",
        entityId: sample!.id as string,
        detail: { size: final.length, seed: input.seed, strata },
      });
      return sample!.id as string;
    });
    return ok({ sampleId, size: final.length, strata });
  } catch (err) {
    return fail(err);
  }
}

export interface AnnotationItem {
  itemId: string;
  position: number;
  promptText: string;
  responseText: string;
  companyName: string;
  companyAliases: string[];
  provider: string;
  remaining: number;
}

/** Next item this annotator has not labelled. The classifier label is
 * deliberately absent (blind annotation). */
export async function nextItemForAnnotator(sampleId: string, annotatorId: string): Promise<AnnotationItem | null> {
  const [row] = await sql`
    select i.id as item_id, i.position, r.prompt_text, r.response_text, r.provider,
      c.name as company_name, c.aliases as company_aliases,
      (select count(*)::int from gold_sample_items i2 where i2.sample_id = ${sampleId}
        and not exists (select 1 from gold_annotations a2 where a2.item_id = i2.id and a2.annotator_id = ${annotatorId})) as remaining
    from gold_sample_items i
    join responses r on r.id = i.response_id
    join companies c on c.id = i.company_id
    where i.sample_id = ${sampleId}
      and not exists (select 1 from gold_annotations a where a.item_id = i.id and a.annotator_id = ${annotatorId})
    order by i.position limit 1
  `;
  if (!row) return null;
  return {
    itemId: row.itemId as string,
    position: row.position as number,
    promptText: row.promptText as string,
    responseText: (row.responseText as string | null) ?? "",
    companyName: row.companyName as string,
    companyAliases: (row.companyAliases as string[]) ?? [],
    provider: row.provider as string,
    remaining: row.remaining as number,
  };
}

const labelSchema = z
  .object({
    itemId: z.string().uuid(),
    sameEntity: z.boolean(),
    mentioned: z.boolean(),
    recommended: z.boolean(),
    notes: z.string().max(1000).optional(),
  })
  .refine((v) => v.mentioned || !v.recommended, "A company that is not mentioned cannot be recommended.")
  .refine((v) => v.sameEntity || !v.mentioned, "A different entity with the same name is not a mention.");

export async function recordAnnotation(user: CurrentUser, raw: unknown): Promise<ActionResult<{ annotationId: string }>> {
  const parsed = labelSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const [existing] = await sql`
      select id from gold_annotations where item_id = ${parsed.data.itemId} and annotator_id = ${user.id}
    `;
    if (existing) return fail(new ClassifiedError("conflict", "You already labelled this item; labels are immutable."));
    const [row] = await sql`
      insert into gold_annotations (item_id, annotator_id, same_entity, mentioned, recommended, notes)
      values (${parsed.data.itemId}, ${user.id}, ${parsed.data.sameEntity}, ${parsed.data.mentioned},
        ${parsed.data.recommended}, ${parsed.data.notes ?? null})
      returning id
    `;
    return ok({ annotationId: row!.id as string });
  } catch (err) {
    return fail(err);
  }
}

const adjudicationSchema = z
  .object({
    itemId: z.string().uuid(),
    sameEntity: z.boolean(),
    mentioned: z.boolean(),
    recommended: z.boolean(),
    reason: z.string().trim().min(3).max(1000),
  })
  .refine((v) => v.mentioned || !v.recommended, "A company that is not mentioned cannot be recommended.")
  .refine((v) => v.sameEntity || !v.mentioned, "A different entity with the same name is not a mention.");

/** Resolve a disputed item. Only items whose annotators disagree qualify. */
export async function adjudicateItem(user: CurrentUser, raw: unknown): Promise<ActionResult<{ adjudicationId: string }>> {
  const parsed = adjudicationSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  try {
    assertCanWrite(user);
    const labels = await sql`
      select same_entity, mentioned, recommended from gold_annotations where item_id = ${parsed.data.itemId}
    `;
    const distinct = new Set(labels.map((l) => `${l.sameEntity}|${l.mentioned}|${l.recommended}`));
    if (labels.length < 2 || distinct.size < 2) {
      return fail(new ClassifiedError("conflict", "Only items with two or more disagreeing annotations are adjudicated."));
    }
    const [row] = await sql`
      insert into gold_adjudications (item_id, adjudicator_id, same_entity, mentioned, recommended, reason)
      values (${parsed.data.itemId}, ${user.id}, ${parsed.data.sameEntity}, ${parsed.data.mentioned},
        ${parsed.data.recommended}, ${parsed.data.reason})
      returning id
    `;
    return ok({ adjudicationId: row!.id as string });
  } catch (err) {
    return fail(err);
  }
}

export interface GoldReport {
  sampleId: string;
  items: number;
  annotatedItems: number;
  mentioned: FieldReport;
  recommended: FieldReport;
  kappaMentioned: number | null;
  kappaRecommended: number | null;
  disputedItemIds: string[];
}

/** Precision/recall of the CURRENT classifier label against human truth. */
export async function goldReport(sampleId: string): Promise<GoldReport> {
  const items = await sql`
    select i.id, i.response_id, i.company_id,
      cm.mentioned as c_mentioned, cm.recommended as c_recommended
    from gold_sample_items i
    left join lateral (
      select m.mentioned, m.recommended from mentions m
      where m.response_id = i.response_id and m.company_id = i.company_id and ${CURRENT_REVISION}
        and (m.parser_version in (${PARSER_VERSION_LLM}, ${PARSER_VERSION_ADJUDICATION}) or m.reviewed_by is not null)
      limit 1
    ) cm on true
    where i.sample_id = ${sampleId}
    order by i.position
  `;
  const ids = items.map((i) => i.id as string);
  const annotations = ids.length
    ? await sql`select item_id, same_entity, mentioned, recommended from gold_annotations where item_id = any(${ids}) order by created_at`
    : [];
  const adjudications = ids.length
    ? await sql`select item_id, same_entity, mentioned, recommended from gold_adjudications where item_id = any(${ids})`
    : [];
  const toLabel = (r: Record<string, unknown>): HumanLabel => ({
    sameEntity: Boolean(r.sameEntity),
    mentioned: Boolean(r.mentioned),
    recommended: Boolean(r.recommended),
  });
  const pairs: PairEvidence[] = items.map((i) => {
    const adj = adjudications.find((a) => a.itemId === i.id);
    return {
      itemId: i.id as string,
      annotations: annotations.filter((a) => a.itemId === i.id).map(toLabel),
      adjudication: adj ? toLabel(adj) : null,
      classifier:
        i.cMentioned === null || i.cMentioned === undefined
          ? null
          : { mentioned: Boolean(i.cMentioned), recommended: Boolean(i.cRecommended) },
    };
  });
  const disputed = pairs.filter((p) => {
    if (p.adjudication || p.annotations.length < 2) return false;
    return new Set(p.annotations.map((a) => `${a.sameEntity}|${a.mentioned}|${a.recommended}`)).size > 1;
  });
  return {
    sampleId,
    items: pairs.length,
    annotatedItems: pairs.filter((p) => p.annotations.length > 0).length,
    mentioned: fieldReport(pairs, "mentioned"),
    recommended: fieldReport(pairs, "recommended"),
    kappaMentioned: cohensKappa(pairs, "mentioned"),
    kappaRecommended: cohensKappa(pairs, "recommended"),
    disputedItemIds: disputed.map((p) => p.itemId),
  };
}

export async function listGoldSamples(): Promise<{ id: string; name: string; targetSize: number; createdAt: Date; items: number }[]> {
  const rows = await sql`
    select s.id, s.name, s.target_size, s.created_at,
      (select count(*)::int from gold_sample_items i where i.sample_id = s.id) as items
    from gold_samples s order by s.created_at desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    targetSize: r.targetSize as number,
    createdAt: r.createdAt as Date,
    items: r.items as number,
  }));
}
