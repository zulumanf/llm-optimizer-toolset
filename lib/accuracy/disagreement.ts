/**
 * Review-queue disagreement rate (spec 050). Every human review of a
 * low-confidence classification writes a new mention revision with reviewer
 * identity — a continuously-produced gold label that was being thrown away
 * as an accuracy signal. This measures it: of the judgments humans reviewed,
 * how often did the human overturn the machine?
 *
 * Deterministic SQL over immutable revisions — no model involved. A rising
 * rate is the early-warning that the classifier (or a provider behind it)
 * drifted; a very low rate over volume is evidence the instrument holds.
 */
import { sql } from "@/db/client";

export interface DisagreementReport {
  windowDays: number;
  reviewed: number;
  overturned: number;
  /** Null when nothing was reviewed in the window — no data is not 0%. */
  disagreementRate: number | null;
  mentionedOverturned: number;
  recommendedOverturned: number;
}

export async function classifierDisagreementRate(
  windowDays = 30
): Promise<DisagreementReport> {
  const rows = await sql`
    select
      count(*)::int as reviewed,
      count(*) filter (
        where prev.mentioned is distinct from cur.mentioned
           or prev.recommended is distinct from cur.recommended
      )::int as overturned,
      count(*) filter (
        where prev.mentioned is distinct from cur.mentioned
      )::int as mentioned_overturned,
      count(*) filter (
        where prev.recommended is distinct from cur.recommended
      )::int as recommended_overturned
    from mentions cur
    join mentions prev
      on prev.response_id = cur.response_id
     and prev.company_id = cur.company_id
     and prev.revision = cur.revision - 1
    where cur.reviewed_by is not null
      and cur.reviewed_at > now() - make_interval(days => ${windowDays})
  `;
  const reviewed = Number(rows[0]?.reviewed ?? 0);
  const overturned = Number(rows[0]?.overturned ?? 0);
  return {
    windowDays,
    reviewed,
    overturned,
    disagreementRate:
      reviewed === 0 ? null : Number((overturned / reviewed).toFixed(4)),
    mentionedOverturned: Number(rows[0]?.mentionedOverturned ?? 0),
    recommendedOverturned: Number(rows[0]?.recommendedOverturned ?? 0),
  };
}
