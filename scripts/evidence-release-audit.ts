/**
 * Spec 136: cohort re-resolution through the canonical evidence release
 * layer. READ-ONLY — sends nothing, resumes nothing, writes nothing.
 *
 * Groups:
 *   A  every approved-but-unsent draft that states a competitive claim
 *      (Touch 1, rewrites whose ancestor carries the snapshot, follow-ups)
 *   B  every paused sequence whose pause names an entity/evidence correction
 *   C  known incidents (Blu House / Ryan Ogle) and every prospect with a
 *      correction row
 *   D  a stratified historical sample of delivered Touch 1s (default 50):
 *      prospect_type × stated prospect count (0 / ≥1) × market, picked in
 *      md5(prospect_id) order so the sample is reproducible and not curated
 *
 * For delivered sends both the SENT snapshot (what the prospect read) and
 * the EFFECTIVE snapshot (latest correction overlaid — what any future
 * artifact states) are verified. Classification compares the live primary
 * count to the sent claim; the gate verdict is the effective one.
 *
 * Run: npx tsx scripts/evidence-release-audit.ts [--sample 50] [--json <path>]
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { latestEvidenceCorrection } from "@/lib/prospects/evidence-corrections";
import { verifyEvidenceRelease, type EvidenceReleaseVerdict, type ReleaseReasonCode } from "@/lib/prospects/evidence-release";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const si = process.argv.indexOf("--sample");
const SAMPLE = si >= 0 ? Number(process.argv[si + 1]) : 50;
const ji = process.argv.indexOf("--json");
const JSON_OUT = ji >= 0 ? process.argv[ji + 1]! : null;
const BLU_HOUSE_COMPANY = "85eba138-983b-4eec-b615-d56cf0c4dfe3";

type Group = "A_SCHEDULED_UNSENT" | "B_PAUSED_CORRECTION" | "C_KNOWN_INCIDENT" | "D_HISTORICAL_SAMPLE";
type Classification =
  | "VERIFIED_UNCHANGED" | "COUNT_CHANGED_DIRECTION_SAME" | "MATERIAL_CORRECTION"
  | "NO_LONGER_ELIGIBLE" | "HUMAN_REVIEW" | "SYSTEMIC_VERIFICATION_FAILURE";
type RootCause =
  | "MISSING_VERIFIED_ALIAS" | "MISSING_TEAM_LEAD_RELATIONSHIP" | "WRONG_ENTITY_LEVEL" | "AMBIGUOUS_IDENTITY"
  | "DUPLICATE_CREDIT" | "RECOMMENDATION_CLASSIFICATION" | "DENOMINATOR" | "PROVIDER_MIX" | "PRODUCTION_RECORD"
  | "RESPONSE_REVISION" | "OTHER";

interface Item {
  group: Group;
  prospectId: string;
  businessName: string;
  prospectType: string | null;
  market: string | null;
  draftId: string | null;
  sendId: string | null;
  sentAt: Date | null;
  sequenceId: string | null;
  pauseReason: string | null;
  snapshot: MismatchEvidenceSnapshot;
}

interface Result extends Omit<Item, "snapshot"> {
  stated: { prospect: number; competitor: number; denominator: number };
  live: { prospect: number | null; competitor: number | null; denominator: number | null };
  shadow: { prospect: number | null; competitor: number | null; denominator: number | null };
  correctionId: string | null;
  /** Valid answers naming a verified identity with no mention row. */
  coverageGaps: { prospect: number; competitor: number };
  sentVerified: boolean | null;
  sentReasons: ReleaseReasonCode[];
  effectiveVerified: boolean;
  effectiveReasons: ReleaseReasonCode[];
  classification: Classification;
  rootCause: RootCause | null;
  error: string | null;
}

const SNAPSHOT_CHAIN = sql`
  with recursive chain as (
    select d.id as draft_id, d.id, d.parent_id, d.evidence_snapshot, 0 as depth from outreach_drafts d
    union all
    select c.draft_id, p.id, p.parent_id, p.evidence_snapshot, c.depth + 1
    from chain c join outreach_drafts p on p.id = c.parent_id where c.evidence_snapshot is null and c.depth < 10
  )
  select distinct on (draft_id) draft_id, evidence_snapshot from chain where evidence_snapshot is not null order by draft_id, depth
`;

const asItem = (group: Group, r: Record<string, unknown>): Item => ({
  group,
  prospectId: r.prospectId as string,
  businessName: r.businessName as string,
  prospectType: (r.prospectType as string | null) ?? null,
  market: (r.market as string | null) ?? null,
  draftId: (r.draftId as string | null) ?? null,
  sendId: (r.sendId as string | null) ?? null,
  sentAt: r.sentAt ? new Date(r.sentAt as Date) : null,
  sequenceId: (r.sequenceId as string | null) ?? null,
  pauseReason: (r.pauseReason as string | null) ?? null,
  snapshot: r.snapshot as MismatchEvidenceSnapshot,
});

async function groupA(): Promise<Item[]> {
  const rows = await sql`
    with snap as (${SNAPSHOT_CHAIN})
    select d.id as draft_id, d.prospect_id, p.business_name, p.prospect_type, l.name as market,
      d.sequence_id, s.touch1_send_id as send_id, null::timestamptz as sent_at, null::text as pause_reason, snap.evidence_snapshot as snapshot
    from outreach_drafts d
    join snap on snap.draft_id = d.id
    join prospects p on p.id = d.prospect_id
    left join market_launches l on l.id = p.launch_id
    left join outreach_followup_sequences s on s.id = d.sequence_id
    where d.status = 'approved' and d.sent_recorded_at is null
    order by d.scheduled_send_at nulls last, d.created_at
  `;
  return rows.map((r) => asItem("A_SCHEDULED_UNSENT", r));
}

async function groupB(): Promise<Item[]> {
  const rows = await sql`
    select s.id as sequence_id, s.prospect_id, p.business_name, p.prospect_type, l.name as market,
      s.touch1_draft_id as draft_id, s.touch1_send_id as send_id, snd.sent_at, s.pause_reason, s.evidence_snapshot as snapshot
    from outreach_followup_sequences s
    join prospects p on p.id = s.prospect_id
    join prospect_outreach_sends snd on snd.id = s.touch1_send_id
    left join market_launches l on l.id = p.launch_id
    where s.status = 'paused'
      and (s.pause_reason ilike '%correction%' or s.pause_reason ilike '%ENTITY_RESOLUTION%'
        or s.pause_reason ilike '%HUMAN_REVIEW%' or s.pause_reason ilike '%evidence%')
    order by p.business_name
  `;
  return rows.map((r) => asItem("B_PAUSED_CORRECTION", r));
}

/** Delivered mismatch Touch 1s: newest Gmail-accepted send per prospect
 * whose draft chain carries the frozen snapshot. */
async function deliveredTouch1s(): Promise<Item[]> {
  const rows = await sql`
    with snap as (${SNAPSHOT_CHAIN})
    select distinct on (s.prospect_id) s.id as send_id, s.prospect_id, s.sent_at, d.id as draft_id,
      p.business_name, p.prospect_type, l.name as market, seq.id as sequence_id, seq.pause_reason, snap.evidence_snapshot as snapshot
    from prospect_outreach_sends s
    join outreach_drafts d on d.id = s.draft_id
    join snap on snap.draft_id = d.id
    join prospects p on p.id = s.prospect_id
    left join market_launches l on l.id = p.launch_id
    left join outreach_followup_sequences seq on seq.touch1_send_id = s.id
    where s.allowed and s.channel = 'gmail' and s.provider_message_id is not null
      and coalesce(d.touch_number, 1) = 1 and d.sequence_id is null
      and snap.evidence_snapshot ->> 'templateVersion' like 'competitive_mismatch%'
    order by s.prospect_id, s.sent_at desc
  `;
  return rows.map((r) => asItem("D_HISTORICAL_SAMPLE", r));
}

/** Deterministic stratified pick: round-robin over strata in md5 order. */
function stratifiedSample(pool: Item[], n: number): Item[] {
  const strata = new Map<string, Item[]>();
  for (const it of pool) {
    const key = `${it.prospectType ?? "?"}|${it.snapshot.prospect.recommendationCount === 0 ? "zero" : "nonzero"}|${it.market ?? "?"}`;
    strata.set(key, [...(strata.get(key) ?? []), it]);
  }
  const keys = [...strata.keys()].sort();
  const out: Item[] = [];
  let round = 0;
  while (out.length < n && out.length < pool.length) {
    for (const k of keys) {
      const bucket = strata.get(k)!;
      if (round < bucket.length && out.length < n) out.push(bucket[round]!);
    }
    round += 1;
  }
  return out;
}

const REVIEW_CODES = new Set<ReleaseReasonCode>([
  "PROSPECT_ENTITY_UNVERIFIED", "COMPETITOR_ENTITY_UNVERIFIED", "AMBIGUOUS_IDENTITY", "ENTITY_LEVEL_MISMATCH",
  "ALIAS_COVERAGE_UNVERIFIED", "RELATIONSHIP_UNVERIFIED", "ZERO_NOT_VERIFIED", "UNRESOLVED_EVIDENCE_ISSUE",
  "PRODUCTION_RECORD_UNVERIFIED", "PRODUCTION_PERIOD_MISMATCH", "PRODUCTION_METRIC_MISMATCH", "PRODUCTION_VALUE_MISMATCH",
  "PROVIDER_MISMATCH", "BENCHMARK_INCOMPLETE", "FROZEN_RUN_MISSING", "RECOMMENDATION_SEMANTICS_UNVERIFIED",
]);
const SYSTEMIC_CODES = new Set<ReleaseReasonCode>(["PRIMARY_SHADOW_COUNT_MISMATCH", "DENOMINATOR_MISMATCH"]);

function classify(stated: Result["stated"], live: Result["live"], effective: EvidenceReleaseVerdict, sent: EvidenceReleaseVerdict | null): Classification {
  const reasons = new Set([...effective.reasons, ...(sent?.reasons ?? [])]);
  if ([...reasons].some((r) => SYSTEMIC_CODES.has(r))) return "SYSTEMIC_VERIFICATION_FAILURE";
  if (effective.reasons.some((r) => REVIEW_CODES.has(r))) return "HUMAN_REVIEW";
  if (live.prospect === null || live.competitor === null) return "HUMAN_REVIEW";
  const changed = live.prospect !== stated.prospect || live.competitor !== stated.competitor;
  if (!changed) return effective.verified ? "VERIFIED_UNCHANGED" : "HUMAN_REVIEW";
  const liveGap = live.competitor - live.prospect;
  if (liveGap < MISMATCH_THRESHOLDS.minRecommendationGap) return "NO_LONGER_ELIGIBLE";
  const zeroFlip = (stated.prospect === 0) !== (live.prospect === 0);
  const gapMoved = Math.abs(liveGap - (stated.competitor - stated.prospect)) >= MISMATCH_THRESHOLDS.minRecommendationGap;
  return zeroFlip || gapMoved ? "MATERIAL_CORRECTION" : "COUNT_CHANGED_DIRECTION_SAME";
}

async function rootCause(it: Item, effective: EvidenceReleaseVerdict, changed: boolean): Promise<RootCause | null> {
  const reasons = effective.reasons;
  if (reasons.includes("DENOMINATOR_MISMATCH")) return "DENOMINATOR";
  if (reasons.includes("PROVIDER_MISMATCH")) return "PROVIDER_MIX";
  if (reasons.includes("AMBIGUOUS_IDENTITY")) return "AMBIGUOUS_IDENTITY";
  if (reasons.includes("ENTITY_LEVEL_MISMATCH")) return "WRONG_ENTITY_LEVEL";
  if (reasons.some((r) => r.startsWith("PRODUCTION_"))) return "PRODUCTION_RECORD";
  if (!changed) return null;
  const correction = await latestEvidenceCorrection(it.prospectId, it.sendId);
  const ids = [it.snapshot.prospect.companyId, it.snapshot.competitor.companyId];
  const change = correction?.entityResolutionChange;
  const aliasCompanies = change ? Object.keys(change.aliasesAdded ?? {}).filter((c) => (change.aliasesAdded[c]?.aliases.length ?? 0) > 0) : [];
  if (aliasCompanies.length === 0 && it.sentAt) {
    const rows = await sql`
      select distinct entity_id from audit_log where entity = 'company' and action = 'company.alias_verified'
        and entity_id::text = any(${ids}::text[]) and at > ${it.sentAt}
    `;
    aliasCompanies.push(...rows.map((r) => r.entityId as string));
  }
  if (aliasCompanies.length > 0) {
    const teams = await sql`
      select distinct company_id from realtrends_records
      where company_id = any(${aliasCompanies}::uuid[]) and entity_type = 'team' and match_status in ('high_confidence', 'confirmed')
    `;
    return teams.length > 0 ? "MISSING_TEAM_LEAD_RELATIONSHIP" : "MISSING_VERIFIED_ALIAS";
  }
  if (change && Object.values(change.mentionRowsAdded ?? {}).some((n) => n > 0)) return "RESPONSE_REVISION";
  if (it.sentAt) {
    const [newer] = await sql`
      select count(*)::int as n from mentions m join responses r on r.id = m.response_id
      where r.run_id = ${it.snapshot.runId} and m.company_id = any(${ids}::uuid[]) and m.revision > 1 and m.created_at > ${it.sentAt}
    `;
    if (Number(newer?.n ?? 0) > 0) return "RECOMMENDATION_CLASSIFICATION";
  }
  return null;
}

async function evaluate(it: Item): Promise<Result> {
  const stated = { prospect: it.snapshot.prospect.recommendationCount, competitor: it.snapshot.competitor.recommendationCount, denominator: it.snapshot.answerCount };
  const base: Omit<Result, "live" | "shadow" | "correctionId" | "coverageGaps" | "sentVerified" | "sentReasons" | "effectiveVerified" | "effectiveReasons" | "classification" | "rootCause" | "error"> = {
    group: it.group, prospectId: it.prospectId, businessName: it.businessName, prospectType: it.prospectType, market: it.market,
    draftId: it.draftId, sendId: it.sendId, sentAt: it.sentAt, sequenceId: it.sequenceId, pauseReason: it.pauseReason, stated,
  };
  try {
    const correction = await latestEvidenceCorrection(it.prospectId, it.sendId);
    const effectiveSnapshot = correction?.correctedSnapshot ?? it.snapshot;
    const ctx = { prospectId: it.prospectId, sendId: it.sendId };
    const effective = await verifyEvidenceRelease(effectiveSnapshot, ctx);
    const sent = it.sendId ? (correction ? await verifyEvidenceRelease(it.snapshot, ctx) : effective) : null;
    const live = effective.diagnostics.primary;
    const changed = live.prospect !== null && live.competitor !== null && (live.prospect !== stated.prospect || live.competitor !== stated.competitor);
    return {
      ...base,
      live,
      shadow: effective.diagnostics.shadow,
      correctionId: correction?.id ?? null,
      coverageGaps: effective.diagnostics.coverageGaps,
      sentVerified: sent ? sent.verified : null,
      sentReasons: sent?.reasons ?? [],
      effectiveVerified: effective.verified,
      effectiveReasons: effective.reasons,
      classification: classify(stated, live, effective, sent),
      rootCause: await rootCause(it, effective, changed),
      error: null,
    };
  } catch (err) {
    return {
      ...base, live: { prospect: null, competitor: null, denominator: null }, shadow: { prospect: null, competitor: null, denominator: null },
      correctionId: null, coverageGaps: { prospect: -1, competitor: -1 }, sentVerified: null, sentReasons: [], effectiveVerified: false, effectiveReasons: [],
      classification: "SYSTEMIC_VERIFICATION_FAILURE", rootCause: "OTHER", error: err instanceof Error ? err.message : String(err),
    };
  }
}

function count<T extends string>(xs: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
}

async function main(): Promise<void> {
  const a = await groupA();
  const b = await groupB();
  const delivered = await deliveredTouch1s();
  const seen = new Set<string>([...a, ...b].map((i) => i.prospectId));
  const corrected = new Set((await sql`select distinct prospect_id from outreach_evidence_corrections`).map((r) => r.prospectId as string));
  const blu = new Set((await sql`select id from prospects where company_id = ${BLU_HOUSE_COMPANY}`).map((r) => r.id as string));
  const c = delivered.filter((i) => (blu.has(i.prospectId) || corrected.has(i.prospectId)) && !seen.has(i.prospectId)).map((i) => ({ ...i, group: "C_KNOWN_INCIDENT" as Group }));
  for (const i of c) seen.add(i.prospectId);
  const pool = delivered.filter((i) => !seen.has(i.prospectId));
  const d = stratifiedSample(pool, SAMPLE);
  const items = [...a, ...b, ...c, ...d];
  console.log(`A scheduled/approved unsent: ${a.length} · B paused (correction): ${b.length} · C known incidents: ${c.length} · D sample: ${d.length} of ${pool.length} delivered (${delivered.length} total delivered)`);

  const results: Result[] = [];
  for (const it of items) {
    const r = await evaluate(it);
    results.push(r);
    const v = r.effectiveVerified ? "VERIFIED" : "BLOCKED ";
    console.log(`${r.group.padEnd(20)} ${v} ${r.classification.padEnd(30)} ${r.businessName.padEnd(34)} stated ${r.stated.prospect}/${r.stated.competitor}/${r.stated.denominator} live ${r.live.prospect ?? "?"}/${r.live.competitor ?? "?"}/${r.live.denominator ?? "?"} shadow ${r.shadow.prospect ?? "?"}/${r.shadow.competitor ?? "?"}${r.coverageGaps.prospect > 0 || r.coverageGaps.competitor > 0 ? ` gaps ${r.coverageGaps.prospect}/${r.coverageGaps.competitor}` : ""}${r.rootCause ? ` · ${r.rootCause}` : ""}${r.effectiveReasons.length ? ` · ${r.effectiveReasons.join(",")}` : ""}${r.error ? ` · ERROR ${r.error.slice(0, 120)}` : ""}`);
  }

  const by = (g: Group) => results.filter((r) => r.group === g);
  const allReasons = results.flatMap((r) => r.effectiveReasons);
  const summary = {
    SCHEDULED_UNSENT_VERIFIED: by("A_SCHEDULED_UNSENT").filter((r) => r.effectiveVerified).length,
    SCHEDULED_UNSENT_BLOCKED: by("A_SCHEDULED_UNSENT").filter((r) => !r.effectiveVerified).length,
    PAUSED_SEQUENCE_VERIFIED: by("B_PAUSED_CORRECTION").filter((r) => r.effectiveVerified).length,
    PAUSED_SEQUENCE_BLOCKED: by("B_PAUSED_CORRECTION").filter((r) => !r.effectiveVerified).length,
    KNOWN_INCIDENT_COUNT: by("C_KNOWN_INCIDENT").length,
    HISTORICAL_SAMPLE_SIZE: by("D_HISTORICAL_SAMPLE").length,
    HISTORICAL_POOL_SIZE: pool.length,
    CLASSIFICATION_ALL: count(results.map((r) => r.classification)),
    CLASSIFICATION_HISTORICAL_SAMPLE: count(by("D_HISTORICAL_SAMPLE").map((r) => r.classification)),
    ROOT_CAUSE: count(results.map((r) => r.rootCause).filter((x): x is RootCause => x !== null)),
    PRIMARY_SHADOW_DISAGREEMENTS: results.filter((r) => r.effectiveReasons.includes("PRIMARY_SHADOW_COUNT_MISMATCH") || r.sentReasons.includes("PRIMARY_SHADOW_COUNT_MISMATCH")).length,
    DENOMINATOR_MISMATCHES: results.filter((r) => r.effectiveReasons.includes("DENOMINATOR_MISMATCH")).length,
    ZERO_COUNT_VERIFICATION_FAILURES: results.filter((r) => r.effectiveReasons.includes("ZERO_NOT_VERIFIED")).length,
    ENTITY_LEVEL_FAILURES: results.filter((r) => r.effectiveReasons.includes("ENTITY_LEVEL_MISMATCH")).length,
    PRODUCTION_COMPARABILITY_FAILURES: results.filter((r) => r.effectiveReasons.some((x) => x.startsWith("PRODUCTION_"))).length,
    COVERAGE_GAP_PROSPECT_SIDE: results.filter((r) => r.coverageGaps.prospect > 0).length,
    COVERAGE_GAP_COMPETITOR_SIDE: results.filter((r) => r.coverageGaps.competitor > 0).length,
    GATE_BLOCK_COUNT: results.filter((r) => !r.effectiveVerified).length,
    REASON_FREQUENCY: count(allReasons),
    STRATA: count(by("D_HISTORICAL_SAMPLE").map((r) => `${r.prospectType ?? "?"}|${r.stated.prospect === 0 ? "zero" : "nonzero"}|${r.market ?? "?"}`)),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify({ summary, results }, null, 2));
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
