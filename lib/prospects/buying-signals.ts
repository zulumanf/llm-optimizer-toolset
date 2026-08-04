/**
 * Buying signals (spec 042): operator-recorded purchase-intent evidence.
 * The target rule is hard — no source URL or observed date, no signal —
 * enforced at the schema (zod) and the table (NOT NULL).
 *
 * The score contribution is deterministic and decays with age: intent
 * evidence goes cold. Zero recorded signals is "not measured" (null), never
 * a fake zero — the final score redistributes the weight.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { PROVENANCE_FACTORS } from "@/lib/prospects/authority";
import {
  BUYING_SIGNAL_KINDS,
  FRESHNESS_WINDOWS_DAYS,
  PROVENANCE_LABELS,
  staleness,
  type ProvenanceLabel,
} from "@/lib/prospects/constants";

/** Base points per active signal before provenance and recency factors. */
export const SIGNAL_BASE_POINTS = 25;

const buyingSignalSchema = z.object({
  prospectId: z.string().uuid(),
  kind: z.enum(BUYING_SIGNAL_KINDS),
  label: z.string().trim().min(1).max(500),
  sourceUrl: z.string().trim().url().max(1000),
  observedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  provenance: z.enum(PROVENANCE_LABELS).default("publicly_sourced"),
  confidence: z.number().min(0).max(1).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export interface BuyingSignalRow {
  id: string;
  kind: string;
  label: string;
  sourceUrl: string;
  observedOn: string;
  provenance: ProvenanceLabel;
  confidence: number | null;
  notes: string | null;
}

export async function addBuyingSignal(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ signalId: string }>> {
  const parsed = buyingSignalSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const signalId = await sql.begin(async (tx) => {
      const [prospect] = await tx`
        select id from prospects where id = ${input.prospectId} and archived_at is null
      `;
      if (!prospect) throw new ClassifiedError("not_found", "Prospect not found.");
      const [row] = await tx`
        insert into prospect_buying_signals
          (prospect_id, kind, label, source_url, observed_on, provenance,
           confidence, notes, created_by)
        values (${input.prospectId}, ${input.kind}, ${input.label},
          ${input.sourceUrl}, ${input.observedOn}, ${input.provenance},
          ${input.confidence ?? null}, ${input.notes ?? null}, ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.buying_signal_add",
        entity: "prospect_buying_signal",
        entityId: row?.id as string,
        detail: { prospectId: input.prospectId, kind: input.kind, observedOn: input.observedOn },
      });
      await tx`
        insert into prospect_activities (prospect_id, kind, detail, actor_id)
        values (${input.prospectId}, 'buying_signal_added',
          ${tx.json({ kind: input.kind, label: input.label } as never)}, ${user.id})
      `;
      return row?.id as string;
    });
    return ok({ signalId });
  } catch (err) {
    return fail(err);
  }
}

export async function archiveBuyingSignal(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ signalId: string }>> {
  const parsed = z.object({ signalId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid signal id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update prospect_buying_signals set archived_at = now()
        where id = ${parsed.data.signalId} and archived_at is null
        returning id, prospect_id
      `;
      if (!row) throw new ClassifiedError("not_found", "Buying signal not found.");
      await writeAudit(tx, {
        userId: user.id,
        action: "prospect.buying_signal_archive",
        entity: "prospect_buying_signal",
        entityId: row.id as string,
        detail: { prospectId: row.prospectId },
      });
    });
    return ok({ signalId: parsed.data.signalId });
  } catch (err) {
    return fail(err);
  }
}

export async function listBuyingSignals(prospectId: string): Promise<BuyingSignalRow[]> {
  const rows = await sql`
    select id, kind, label, source_url, observed_on::text, provenance, confidence, notes
    from prospect_buying_signals
    where prospect_id = ${prospectId} and archived_at is null
    order by observed_on desc
  `;
  return rows.map((r) => ({
    id: r.id as string,
    kind: r.kind as string,
    label: r.label as string,
    sourceUrl: r.sourceUrl as string,
    observedOn: r.observedOn as string,
    provenance: r.provenance as ProvenanceLabel,
    confidence: r.confidence === null ? null : Number(r.confidence),
    notes: (r.notes as string | null) ?? null,
  }));
}

/** Recency factor on the freshness bands: 1 within the window, 0.5 within
 * twice the window, 0 beyond — intent evidence goes cold. */
export function recencyFactor(observedOn: string, now: Date = new Date()): number {
  const { ageDays } = staleness(observedOn, FRESHNESS_WINDOWS_DAYS.buyingSignal, now);
  if (ageDays <= FRESHNESS_WINDOWS_DAYS.buyingSignal) return 1;
  if (ageDays <= 2 * FRESHNESS_WINDOWS_DAYS.buyingSignal) return 0.5;
  return 0;
}

/** 0–100 or null when no signals exist (not measured, never fake zero). */
export function buyingSignalScore(
  signals: Pick<BuyingSignalRow, "observedOn" | "provenance" | "confidence">[],
  now: Date = new Date()
): number | null {
  if (signals.length === 0) return null;
  const total = signals.reduce(
    (acc, s) =>
      acc +
      SIGNAL_BASE_POINTS *
        PROVENANCE_FACTORS[s.provenance] *
        (s.confidence ?? 1) *
        recencyFactor(s.observedOn, now),
    0
  );
  return Math.min(100, total);
}
