/**
 * Fresh-prospect discovery pass (2026-08-31). Finds NEW, uncontacted
 * prospects that meet the spec-124 competitive-mismatch standard, using
 * only existing canonical machinery:
 *
 * - Pool A: existing uncontacted, non-DNC prospects → competitiveMismatchReview.
 * - Pool B: RealTrends-verified entities in our BENCHMARKED cities that are
 *   not tracked at all: production from realtrends_records, recommendation
 *   count 0 established deterministically (whole-word scan of every valid
 *   OpenAI answer in the market's freshest run — an entity never named can
 *   never have been recommended; any name hit routes to identity review
 *   instead, never to a claimed count). Competitors are the tracked,
 *   dataset-verified companies with live counts (spec 124 pool).
 * - Stage 2: rank NEW candidate markets from the licensed dataset; prepare
 *   benchmark launch plans with cost estimates — never spends.
 *
 * Read-only against outreach state. Nothing is sent, no rows are written.
 * Outputs to gitignored .local-data/prospecting/.
 *
 * Run: npx tsx scripts/fresh-prospect-discovery.ts
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import {
  benchmarkScopeCopy,
  competitiveMismatchReview,
  evaluateMismatch,
  formatProductionDisplay,
  mismatchStrength,
  type CompetitiveMismatchReview,
  type MismatchEntityInput,
  type MismatchReasonCode,
} from "@/lib/prospects/mismatch";
import { generateCompetitiveMismatchEmail } from "@/lib/prospects/outreach";
import {
  datasetProductionByCompany,
  launchGeographies,
  REALTRENDS_DATASET_SOURCE_REF,
} from "@/lib/prospects/realtrends-dataset";
import { providerRecommendationCounts } from "@/lib/prospects/benchmark";
import { latestVerifiedProductionByProspect } from "@/lib/prospects/realtrends";
import type { ProductionEvidence } from "@/lib/prospects/realtrends";
import { scoreNameMatch } from "@/lib/knowledge/normalize";

const OUT_DIR = ".local-data/prospecting";
/** ICP floor for a fresh candidate: below this the claim is technically
 * true but strategically unimpressive in these markets. */
const MIN_CANDIDATE_VOLUME_USD = 15_000_000;
const BENCHMARK_CODES: MismatchReasonCode[] = [
  "BENCHMARK_TOO_OLD",
  "NO_BENCHMARK",
  "BENCHMARK_SCOPE_INVALID",
  "CHATGPT_DATA_UNAVAILABLE",
];

const escapeAre = (s: string): string =>
  s.replace(/([[\]^$.|?*+(){}\\])/g, "\\$1");

const firstToken = (s: string | null): string | null =>
  s?.trim().split(/\s+/)[0] ?? null;

async function freshestRunByLaunch(): Promise<
  Map<string, { runId: string; completedAt: Date; answerCount: number }>
> {
  const rows = await sql`
    select distinct on (p.launch_id) p.launch_id, r.id as run_id, r.completed_at,
      (select count(*)::int from responses x
        where x.run_id = r.id and x.provider = 'openai' and x.error is null) as openai
    from prospects p
    join prospect_benchmarks pb on pb.prospect_id = p.id
    join runs r on r.id = pb.run_id
    where p.archived_at is null and r.completed_at is not null
    order by p.launch_id, r.completed_at desc
  `;
  return new Map(
    rows
      .filter((r) => Number(r.openai) > 0)
      .map((r) => [
        r.launchId as string,
        {
          runId: r.runId as string,
          completedAt: new Date(r.completedAt as Date),
          answerCount: Number(r.openai),
        },
      ])
  );
}

async function runAudiences(runId: string): Promise<string[]> {
  const rows = await sql`
    select distinct p.audience
    from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id,
    jsonb_to_recordset(v.frozen_prompts) as p(audience text, "isHoldout" boolean)
    where r.id = ${runId} and not coalesce(p."isHoldout", false)
      and p.audience is not null
  `;
  return rows.map((r) => r.audience as string);
}

async function main(): Promise<void> {
  const now = new Date();
  mkdirSync(OUT_DIR, { recursive: true });
  const launches = await sql`
    select l.id, l.name from market_launches l
    where l.archived_at is null
      and exists (select 1 from prospects p where p.launch_id = l.id and p.archived_at is null)
  `;
  const geos = await launchGeographies();
  const runByLaunch = await freshestRunByLaunch();

  // ------------------------------------------------ Pool A: uncontacted prospects
  const poolARows = await sql`
    select p.id, p.business_name, p.launch_id, l.name as launch_name,
      (p.email is not null or exists (select 1 from prospect_contacts c
        where c.prospect_id = p.id and c.archived_at is null
          and not c.do_not_contact and c.email is not null)) as has_email
    from prospects p join market_launches l on l.id = p.launch_id
    where p.archived_at is null and not p.do_not_contact
      and not exists (select 1 from prospect_outreach_sends s
        where s.prospect_id = p.id and s.allowed)
  `;
  const sendReady: Record<string, unknown>[] = [];
  const refreshNeeded: Record<string, unknown>[] = [];
  const enrichmentQueue: Record<string, unknown>[] = [];
  const identityReview: Record<string, unknown>[] = [];
  const ineligible: { name: string; reasons: string[] }[] = [];

  for (const row of poolARows) {
    const review = await competitiveMismatchReview(row.id as string);
    if (!review) continue;
    const e = review.evaluation;
    if (e.eligible && e.selected) {
      const c = e.selected;
      const entry = {
        pool: "existing_prospect",
        prospectId: row.id,
        prospect: row.businessName,
        market: review.marketName,
        entityType: review.prospect.production!.entityType,
        volumeDisplay: formatProductionDisplay(
          c.metricType!,
          c.metricType === "closed_volume"
            ? review.prospect.production!.volumeUsd
            : review.prospect.production!.sides
        ),
        volumeUsd: review.prospect.production!.volumeUsd,
        sides: review.prospect.production!.sides,
        competitor: c.displayName,
        competitorVolumeUsd: c.production!.volumeUsd,
        prospectRecs: review.prospect.recommendationCount,
        competitorRecs: c.recommendationCount,
        denominator: review.benchmark!.answerCount,
        gap: c.recommendationGap,
        ratio: c.productionRatio,
        benchmarkCapturedAt: review.benchmark!.capturedAt,
        firstName: review.firstName,
        strength: mismatchStrength(c),
        hasEmail: Boolean(row.hasEmail),
        review,
        selected: c,
      };
      if (row.hasEmail) sendReady.push(entry);
      else
        enrichmentQueue.push({
          ...entry,
          missing: "recipient email (prospect exists, hook eligible)",
        });
    } else if (
      e.reasonCodes.length > 0 &&
      e.reasonCodes.every((code) => BENCHMARK_CODES.includes(code))
    ) {
      const fresh = runByLaunch.get(row.launchId as string);
      refreshNeeded.push({
        pool: "existing_prospect",
        prospect: row.businessName,
        market: review.marketName,
        reasons: e.reasonCodes,
        note: fresh
          ? `fresh run ${fresh.runId} (${fresh.completedAt.toISOString().slice(0, 10)}) exists — relink benchmark + regenerate finding, no new spend`
          : "no completed run for this launch",
      });
    } else {
      ineligible.push({ name: row.businessName as string, reasons: e.reasonCodes });
    }
  }

  // ------------------------------------------- Pool B: untracked RealTrends entities
  // Existing names to dedupe against (all launches — never recontact a
  // variant of someone we already touched anywhere).
  const knownNames: string[] = (
    await sql`
      select business_name as n from prospects where archived_at is null
      union select team_leader from prospects where archived_at is null and team_leader is not null
      union select name from companies where archived_at is null and merged_into is null
    `
  ).map((r) => r.n as string);

  for (const launch of launches) {
    const launchId = launch.id as string;
    const geo = geos.find((g) => g.launchId === launchId);
    const run = runByLaunch.get(launchId);
    if (!geo?.state || !run) continue;
    const ageDays = Math.floor((now.getTime() - run.completedAt.getTime()) / 86_400_000);
    if (ageDays > MISMATCH_THRESHOLDS.maxBenchmarkAgeDays) continue;
    const audiences = await runAudiences(run.runId);
    const scopeCopy = benchmarkScopeCopy(geo.city, audiences);

    // Competitor pool: tracked companies with current recommended mentions
    // in this run AND verified dataset production.
    const mentioned = await sql`
      select distinct m.company_id from mentions m
      join responses r on r.id = m.response_id
      where r.run_id = ${run.runId} and r.error is null and m.recommended
    `;
    const mentionedIds = mentioned.map((r) => r.companyId as string);
    const counts = await providerRecommendationCounts(run.runId, "openai", mentionedIds);
    const datasetProd = await datasetProductionByCompany(mentionedIds);
    // Peer-prospect signal production as competitor fallback (JC etc.)
    const peerProspects = await sql`
      select id, company_id, business_name from prospects
      where launch_id = ${launchId} and archived_at is null and company_id is not null
    `;
    const signalProd = await latestVerifiedProductionByProspect(
      peerProspects.map((r) => r.id as string)
    );
    const companyName = new Map(
      (
        await sql`select id, name from companies where id = any(${mentionedIds}::uuid[])`
      ).map((r) => [r.id as string, r.name as string])
    );
    const competitors: MismatchEntityInput[] = mentionedIds
      .map((cid) => {
        const peer = peerProspects.find((r) => r.companyId === cid);
        const production =
          datasetProd.get(cid) ??
          (peer ? (signalProd.get(peer.id as string) ?? null) : null);
        return {
          companyId: cid,
          prospectId: peer ? (peer.id as string) : null,
          displayName: peer
            ? (peer.businessName as string)
            : (companyName.get(cid) ?? "unknown"),
          production,
          recommendationCount: counts.recommendedByCompany[cid] ?? 0,
        };
      })
      .filter((c) => c.production !== null && c.recommendationCount > 0);

    // Fresh universe: unmatched dataset records in this city+state above the
    // ICP floor. (Matched records are existing tracked entities — pool A.)
    const records = await sql`
      select id, entity_type, entity_name, team_lead, brokerage, city, state,
        volume_usd, sides, production_year
      from realtrends_records
      where lower(city) = ${geo.city.toLowerCase()} and state = ${geo.state}
        and match_status = 'unmatched'
        and volume_usd is not null and volume_usd >= ${MIN_CANDIDATE_VOLUME_USD}
      order by volume_usd desc
    `;
    const seenNames = new Set<string>();
    for (const record of records) {
      const name = record.entityName as string;
      const teamLead = (record.teamLead as string | null) ?? null;
      const lower = name.toLowerCase();
      if (seenNames.has(lower)) continue;
      seenNames.add(lower);
      if (teamLead) seenNames.add(teamLead.toLowerCase());
      // Dedupe vs every prospect/company/team-leader name we know anywhere.
      const collides = knownNames.some(
        (known) => scoreNameMatch(name, known).matchStatus === "exact"
      );
      if (collides) continue;

      // Deterministic zero-presence proof: the ENTITY NAME never appears in
      // any valid OpenAI answer of the fresh run (team names and agents'
      // full names only — the Teams sheet's lead is a bare first name, which
      // would match everything and prove nothing). A hit means the entity
      // may have real mentions — identity review, never a guessed count.
      const pattern = "\\m" + escapeAre(name.trim()) + "\\M";
      const [hit] = await sql`
        select count(*)::int as n from responses r
        where r.run_id = ${run.runId} and r.provider = 'openai'
          and r.error is null and r.response_text ~* ${pattern}
      `;
      const appears = Number(hit?.n ?? 0);
      const production: ProductionEvidence = {
        signalId: record.id as string,
        prospectId: null,
        entityType: record.entityType as "individual" | "team",
        source: "RealTrends verified dataset",
        rank: null,
        rankScope: "RealTrends verified dataset",
        scopeComparable: true,
        volumeUsd: Number(record.volumeUsd),
        sides: record.sides === null ? 0 : Math.round(Number(record.sides)),
        avgPerSideUsd: null,
        productionYear: Number(record.productionYear),
        sourceUrl: REALTRENDS_DATASET_SOURCE_REF,
        retrievedOn: now.toISOString().slice(0, 10),
      };
      const firstName =
        record.entityType === "team" ? firstToken(teamLead) : firstToken(name);
      // `appears` is a deterministic UPPER BOUND on the candidate's
      // recommendation count (an entity never named in an answer cannot have
      // been recommended in it). appears = 0 → the count IS 0, claimable.
      // appears > 0 → exact count needs real parsing; if the mismatch holds
      // even at the upper bound, parsing is guaranteed to confirm
      // eligibility — queue it as a priority parse, never as a claim.
      const evaluation = evaluateMismatch({
        now,
        firstName,
        prospect: {
          companyId: record.id as string, // synthetic id — candidate is untracked
          production,
          recommendationCount: appears,
        },
        candidates: competitors,
        benchmark: { answerCount: run.answerCount, completedAt: run.completedAt },
      });
      if (appears > 0) {
        identityReview.push({
          candidate: name,
          market: `${geo.city}, ${geo.state}`,
          recordId: record.id,
          brokerage: record.brokerage,
          volumeUsd: Number(record.volumeUsd),
          nameHits: appears,
          eligibleAtUpperBound: evaluation.eligible,
          bestRival: evaluation.selected
            ? `${evaluation.selected.displayName} (${evaluation.selected.recommendationCount}/${run.answerCount}, ${formatProductionDisplay("closed_volume", evaluation.selected.production!.volumeUsd)})`
            : null,
          ambiguity: `name appears in ${appears} OpenAI answer(s) but the entity is untracked — exact recommendation count unknown`,
          evidence: "whole-word scan of the fresh run's valid OpenAI answers",
          recommendedResolution: evaluation.eligible
            ? "PRIORITY: promote to tracked company + parse mentions — mismatch already holds at the upper-bound count, parsing can only confirm"
            : "promote to a tracked company (brand candidate flow) and parse mentions before any claim",
        });
        continue;
      }
      if (!evaluation.eligible || !evaluation.selected) {
        if (evaluation.reasonCodes.includes("NO_RECIPIENT_FIRST_NAME")) {
          enrichmentQueue.push({
            pool: "realtrends_fresh",
            prospect: name,
            market: `${geo.city}, ${geo.state}`,
            brokerage: record.brokerage,
            volumeUsd: Number(record.volumeUsd),
            missing: "recipient name (and email)",
          });
        }
        continue;
      }
      const c = evaluation.selected;
      // Render the candidate Touch 1 with the existing template (preview
      // only — these entities have no contact yet, nothing can send).
      const reviewShape: CompetitiveMismatchReview = {
        prospectId: record.id as string,
        runId: run.runId,
        marketName: `${geo.city}, ${geo.state}`,
        audiences,
        scopeCopy,
        benchmark: {
          provider: "openai",
          answerCount: run.answerCount,
          modelCount: 1, // verified: all current OpenAI answers are one model
          capturedAt: run.completedAt,
          recommendedByCompany: {},
        },
        benchmarkCompletedAt: run.completedAt,
        firstName,
        prospect: {
          companyId: record.id as string,
          displayName: name,
          production,
          recommendationCount: 0,
        },
        evaluation,
      };
      const preview = generateCompetitiveMismatchEmail(reviewShape, c, now);
      enrichmentQueue.push({
        pool: "realtrends_fresh",
        subject: preview.subject,
        body: preview.body,
        recordId: record.id,
        prospect: name,
        entityType: record.entityType,
        market: `${geo.city}, ${geo.state}`,
        brokerage: record.brokerage,
        volumeUsd: Number(record.volumeUsd),
        volumeDisplay: formatProductionDisplay("closed_volume", Number(record.volumeUsd)),
        sides: record.sides === null ? null : Number(record.sides),
        reportingYear: Number(record.productionYear),
        competitor: c.displayName,
        competitorVolumeUsd: c.production!.volumeUsd,
        prospectRecs: 0,
        competitorRecs: c.recommendationCount,
        denominator: run.answerCount,
        gap: c.recommendationGap,
        ratio: c.productionRatio,
        benchmarkCapturedAt: run.completedAt,
        scopeCopy,
        firstName,
        strength: mismatchStrength(c),
        missing: "email + contact record (entity is not yet a prospect)",
      });
    }
  }

  // --------------------------------------------- Stage 2: new-market ranking
  const currentCities = geos
    .filter((g) => g.state)
    .map((g) => `${g.city.toLowerCase()}|${g.state}`);
  const marketRows = await sql`
    select city, state,
      count(*) filter (where entity_type = 'team' and volume_usd >= 20000000)::int as teams_20m,
      count(*) filter (where volume_usd >= 15000000)::int as entities_15m,
      max(volume_usd) as top_volume,
      percentile_cont(0.9) within group (order by volume_usd) filter (where volume_usd >= 10000000) as p90,
      percentile_cont(0.5) within group (order by volume_usd) filter (where volume_usd >= 10000000) as p50
    from realtrends_records
    group by city, state
    having count(*) filter (where entity_type = 'team' and volume_usd >= 20000000) >= 5
    order by teams_20m desc
    limit 60
  `;
  const newMarkets = marketRows
    .filter(
      (m) =>
        !currentCities.includes(`${(m.city as string).toLowerCase()}|${m.state}`) &&
        !(m.state === "NY" && /new york|brooklyn|queens|bronx|staten island|manhattan/i.test(m.city as string))
    )
    .map((m) => ({
      market: `${m.city}, ${m.state}`,
      verifiedTeams20mPlus: Number(m.teams20m),
      entities15mPlus: Number(m.entities15m),
      topVolumeUsd: Number(m.topVolume),
      disparityP90overP50:
        m.p50 && Number(m.p50) > 0
          ? Math.round((Number(m.p90) / Number(m.p50)) * 10) / 10
          : null,
      // 5–15 concentrated prospects per launch is the operating shape;
      // pool depth beyond ~30 mostly adds noise for a first batch.
      estimatedProspectPool: Math.min(15, Math.max(5, Math.floor(Number(m.teams20m) / 2))),
      estimatedBenchmarkCostUsd: 5, // observed range $2.2–$4.8 per 256-answer market run
      note: "prepared only — launching a city pipeline is an operator spend decision",
    }))
    .sort(
      (a, b) =>
        b.verifiedTeams20mPlus - a.verifiedTeams20mPlus ||
        (b.disparityP90overP50 ?? 0) - (a.disparityP90overP50 ?? 0)
    )
    .slice(0, 10);

  // -------------------------------------------------------- outputs + summary
  const rank = (x: Record<string, unknown>): number =>
    (x.strength === "strong" ? 1_000_000 : 0) +
    (x.gap as number) * 1_000 +
    Math.min(999, Math.round((x.volumeUsd as number) / 1_000_000));
  const hookReady = enrichmentQueue.filter((x) => x.gap !== undefined);
  hookReady.sort((a, b) => rank(b) - rank(a));
  sendReady.sort((a, b) => rank(b) - rank(a));

  const strip = ({ review: _r, selected: _s, ...rest }: Record<string, unknown>) => rest;
  writeFileSync(
    `${OUT_DIR}/fresh-prospect-cohort.json`,
    JSON.stringify({ sendReady: sendReady.map(strip), hookReadyNeedingContact: hookReady }, null, 2)
  );
  // Send-queue previews: pool-A eligibles (render from their live review)
  // plus every hook-ready fresh entity's preview. Nothing here sends.
  const previews = [
    ...sendReady.map((x) => {
      const draft = generateCompetitiveMismatchEmail(
        x.review as CompetitiveMismatchReview,
        x.selected as never,
        now
      );
      return { ...strip(x), subject: draft.subject, body: draft.body };
    }),
    ...hookReady,
  ];
  writeFileSync(`${OUT_DIR}/fresh-send-queue.json`, JSON.stringify(previews, null, 2));
  writeFileSync(
    `${OUT_DIR}/refresh-candidates.json`,
    JSON.stringify({ existingProspects: refreshNeeded, newMarkets }, null, 2)
  );
  writeFileSync(
    `${OUT_DIR}/contact-enrichment-queue.json`,
    JSON.stringify(enrichmentQueue, null, 2)
  );
  writeFileSync(`${OUT_DIR}/identity-review.json`, JSON.stringify(identityReview, null, 2));

  console.log(`Pool A uncontacted prospects evaluated: ${poolARows.length}`);
  console.log(`SEND_READY (existing prospect, email on file): ${sendReady.length}`);
  console.log(`Hook-ready fresh RealTrends entities (need contact): ${hookReady.length}`);
  console.log(`Refresh-needed (existing prospects): ${refreshNeeded.length}`);
  console.log(`Identity review: ${identityReview.length}`);
  console.log(`Ineligible pool A: ${ineligible.length}`);
  console.log(`Candidate NEW markets ranked: ${newMarkets.length}`);
  console.log("\nTOP HOOK-READY FRESH ENTITIES:");
  for (const x of hookReady.slice(0, 30)) {
    console.log(
      `${String(x.strength).toUpperCase().padEnd(6)} ${x.market} · ${x.prospect} (${x.entityType}, ${x.brokerage ?? "—"})` +
        ` · RT ${x.volumeDisplay} vs ${x.competitor} ${formatProductionDisplay("closed_volume", x.competitorVolumeUsd as number)}` +
        ` · OpenAI 0→${x.competitorRecs} of ${x.denominator} · first name ${x.firstName}`
    );
  }
  console.log("\nSEND_READY existing prospects:");
  for (const x of sendReady) {
    console.log(
      `${String(x.strength).toUpperCase().padEnd(6)} ${x.market} · ${x.prospect} vs ${x.competitor}` +
        ` · ${x.prospectRecs}→${x.competitorRecs} of ${x.denominator} · email ✓`
    );
  }
  console.log("\nTOP NEW MARKETS:");
  for (const m of newMarkets) {
    console.log(
      `${m.market} · teams≥$20M: ${m.verifiedTeams20mPlus} · top ${formatProductionDisplay("closed_volume", m.topVolumeUsd)} · disparity ${m.disparityP90overP50 ?? "—"} · est pool ${m.estimatedProspectPool} · est run $${m.estimatedBenchmarkCostUsd}`
    );
  }
  console.log("\nIneligible pool A reasons sample:");
  const tally = new Map<string, number>();
  for (const i of ineligible) for (const r of i.reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
