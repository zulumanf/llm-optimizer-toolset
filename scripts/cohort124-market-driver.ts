/**
 * Cohort-124 new-market driver (2026-08-31). Opens one market end-to-end
 * using existing services, with RealTrends preselection REPLACING Perplexity
 * discovery (the licensed dataset is the prospect universe):
 *
 *   market pack draft+install → state declare → RealTrends-selected teams
 *   as prospects (top producers) + extra tracked companies (rival universe)
 *   → bootstrap market benchmark → competitors → cost-guarded run start.
 *
 * The deployed worker executes the run (jobs queue), parses, and scores.
 * Post-run linking/eligibility happens in cohort124-postrun.
 *
 * Run: npx tsx scripts/cohort124-market-driver.ts --city Chicago --state IL
 * Optional: --prospects 24 --extras 26 --budget 8
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { draftMarketPack, installMarketPackDraft } from "@/lib/markets/research";
import { bootstrapMarketBenchmark } from "@/lib/markets/bootstrap";
import { upsertCompany } from "@/lib/companies/service";
import { addCompetitor } from "@/lib/competitors/service";
import { estimateRunForVersion, startRun } from "@/lib/runs/service";
import { createProspect } from "@/lib/prospects/service";
import { suggestCompanyForProspect, confirmCompanyLink } from "@/lib/prospects/discovery";
import { matchDatasetRecords, setMarketState } from "@/lib/prospects/realtrends-dataset";

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

const arg = (flag: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

async function main(): Promise<void> {
  const city = arg("--city");
  const state = arg("--state");
  if (!city || !state) throw new Error("--city and --state required");
  const targetProspects = Number(arg("--prospects", "24"));
  const extraCompanies = Number(arg("--extras", "26"));
  const budgetUsd = Number(arg("--budget", "8"));
  const user = await operatorUser();

  // 1. Launch (reuse only a launch whose market is declared in THIS state —
  // same-named cities in other states must never match: Wilmington DE ≠ NC).
  let launchId: string;
  const [existing] = await sql`
    select l.id from market_launches l join markets m on m.id = l.market_id
    where l.archived_at is null and m.name ilike ${city + "%"}
      and m.state_code = ${state}
    order by l.created_at desc limit 1
  `;
  if (existing) {
    launchId = existing.id as string;
    console.log(`launch reused: ${launchId}`);
  } else {
    const draft = await draftMarketPack(user, { cityName: city, state });
    if (!draft.ok || !draft.data.pack) {
      throw new Error(`market pack: ${draft.ok ? draft.data.error : draft.error.message}`);
    }
    const installed = await installMarketPackDraft(user, { draftId: draft.data.draftId });
    if (installed.ok) {
      launchId = installed.data.launchId;
      console.log(`market pack installed; launch ${launchId}`);
    } else {
      // Active launch names are globally unique, so a same-named city in
      // another state (Wilmington DE vs NC) blocks the default name. The
      // pack's geo nodes install before the launch, so find THIS state's
      // city node and create the launch under a state-suffixed name.
      const stateNames: Record<string, string> = {
        NC: "North Carolina", SC: "South Carolina", VA: "Virginia", CO: "Colorado",
        IN: "Indiana", MO: "Missouri", NV: "Nevada", TN: "Tennessee", MI: "Michigan",
        KY: "Kentucky", FL: "Florida", MD: "Maryland", GA: "Georgia",
      };
      const [cityNode] = await sql`
        with recursive up as (
          select m.id, m.parent_id, m.id as city_id
          from markets m
          where m.kind = 'city' and lower(m.name) = ${city.toLowerCase()}
          union all
          select p.id, p.parent_id, up.city_id
          from markets p join up on p.id = up.parent_id
        )
        select distinct up.city_id as id from up
        join markets anc on anc.id = up.id
        where lower(anc.name) in (${(stateNames[state] ?? state).toLowerCase()}, ${state.toLowerCase()})
      `;
      if (!cityNode) throw new Error(`install: ${installed.error.message} (no city node found either)`);
      const { createLaunch } = await import("@/lib/prospects/service");
      const fallback = await createLaunch(user, {
        name: `${city} ${state} — luxury residential`,
        marketId: cityNode.id as string,
        priceSegment: "luxury",
        serviceCategory: "residential brokerage",
      });
      if (!fallback.ok) throw new Error(`install fallback: ${fallback.error.message}`);
      launchId = fallback.data.launchId as string;
      console.log(`launch created via state-suffixed fallback: ${launchId}`);
    }
  }
  const [launchMarket] = await sql`
    select market_id from market_launches where id = ${launchId}`;
  const declared = await setMarketState(user, {
    marketName: city,
    state,
    marketId: launchMarket!.marketId as string,
  });
  if (!declared.ok) throw new Error(`state declare: ${declared.error.message}`);

  // 2. RealTrends preselection. Prospects: top teams AND top solo agents by
  // volume (ICP floor $20M; cohort targets ~60/40 team/agent, and mismatch
  // comparisons are same-entity-type, so both universes must be tracked).
  // Extra companies: the next tier down to $8M in BOTH types — the candidate
  // RIVAL universe, tracked so the parser counts them and the dataset
  // matcher can attach verified production.
  const records = await sql`
    select id, entity_name, team_lead, brokerage, volume_usd, sides, entity_type
    from realtrends_records
    where lower(city) = ${city.toLowerCase()} and state = ${state}
      and volume_usd is not null
    order by volume_usd desc
  `;
  const seen = new Set<string>();
  const unique = records.filter((r) => {
    const k = (r.entityName as string).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const teamShare = Math.round(targetProspects * 0.6);
  const teams20 = unique.filter(
    (r) => r.entityType === "team" && Number(r.volumeUsd) >= 20_000_000
  );
  const agents20 = unique.filter(
    (r) => r.entityType !== "team" && Number(r.volumeUsd) >= 20_000_000
  );
  const prospectRows = [
    ...teams20.slice(0, teamShare),
    ...agents20.slice(0, targetProspects - teamShare),
  ];
  const prospectSet = new Set(prospectRows.map((r) => r.id));
  // Rival universe: every remaining $20M+ entity (they are both comparison
  // candidates and future prospects), then fill down to $8M, half per type.
  const remaining20 = unique.filter(
    (r) => !prospectSet.has(r.id) && Number(r.volumeUsd) >= 20_000_000
  );
  const midTier = (type: "team" | "individual") =>
    unique.filter(
      (r) =>
        (type === "team" ? r.entityType === "team" : r.entityType !== "team") &&
        Number(r.volumeUsd) >= 8_000_000 &&
        Number(r.volumeUsd) < 20_000_000
    );
  const fill = Math.max(0, extraCompanies - remaining20.length);
  const extraRows = [
    ...remaining20,
    ...midTier("team").slice(0, Math.ceil(fill / 2)),
    ...midTier("individual").slice(0, Math.floor(fill / 2)),
  ].slice(0, Math.max(extraCompanies, remaining20.length));

  let created = 0;
  for (const r of prospectRows) {
    const res = await createProspect(user, {
      launchId,
      businessName: r.entityName as string,
      prospectType: r.entityType === "team" ? "team" : "individual_agent",
      // A solo agent's entity name IS the decision-maker; teams carry their
      // RealTrends team_lead. firstName in drafts falls back to this field.
      teamLeader:
        (r.teamLead as string | null) ??
        (r.entityType !== "team" ? (r.entityName as string) : undefined),
      brokerageAffiliation: (r.brokerage as string | null) ?? undefined,
      estTransactionVolumeUsd: Math.round(Number(r.volumeUsd)),
      source: "manual",
      fieldProvenance: { businessName: "verified", estTransactionVolumeUsd: "verified" },
    });
    if (res.ok) created += 1;
    else if (!/already exists|duplicate/i.test(res.error.message)) {
      console.log(`prospect FAILED ${r.entityName}: ${res.error.message}`);
    }
  }
  console.log(`prospects created: ${created}/${prospectRows.length}`);

  // 3. Companies: link every prospect (pipeline pattern) + mint extras.
  const unlinked = await sql`
    select id, business_name from prospects
    where launch_id = ${launchId} and archived_at is null and company_id is null
  `;
  for (const row of unlinked) {
    const suggestion = await suggestCompanyForProspect(row.id as string);
    let companyId = suggestion?.verdict === "match" ? suggestion.companyId : null;
    if (!companyId) {
      const minted = await upsertCompany(user, { name: row.businessName as string, aliases: [] });
      if (!minted.ok) continue;
      companyId = minted.data.id as string;
    }
    await confirmCompanyLink(user, { prospectId: row.id as string, companyId });
  }
  const extraCompanyIds: string[] = [];
  for (const r of extraRows) {
    const minted = await upsertCompany(user, { name: r.entityName as string, aliases: [] });
    if (minted.ok) extraCompanyIds.push(minted.data.id as string);
  }
  console.log(`extra rival companies tracked: ${extraCompanyIds.length}/${extraRows.length}`);

  // 4. Bootstrap benchmark + track everything in the project.
  const boot = await bootstrapMarketBenchmark(user, { launchId });
  if (!boot.ok) throw new Error(`bootstrap: ${boot.error.message}`);
  const prospectCompanies = await sql`
    select distinct company_id from prospects
    where launch_id = ${launchId} and archived_at is null and company_id is not null
  `;
  for (const c of [...prospectCompanies.map((r) => r.companyId as string), ...extraCompanyIds]) {
    await addCompetitor(user, { projectId: boot.data.projectId, companyId: c, tier: "secondary" });
  }

  // 5. Canonical dataset→company resolution for production evidence.
  await matchDatasetRecords(user);

  // 6. Cost-guarded run start (worker executes).
  const providers = boot.data.suggestedProviders as
    | { provider: string; model: string; repetitions: number }[]
    | null;
  if (!providers || providers.length === 0) throw new Error("no provider config to copy");
  const estimate = await estimateRunForVersion({
    promptSetVersionId: boot.data.promptSetVersionId,
    providers,
  });
  if (!estimate.ok) throw new Error(`estimate: ${estimate.error.message}`);
  const estimated = estimate.data.estimatedMicroUsd / 1_000_000;
  if (estimated > budgetUsd) {
    throw new Error(`STOP: estimated $${estimated.toFixed(2)} exceeds budget $${budgetUsd}`);
  }
  const run = await startRun(
    user,
    {
      projectId: boot.data.projectId,
      promptSetVersionId: boot.data.promptSetVersionId,
      providers,
      budgetUsd,
      label: `Cohort 124 batch 1: ${city}, ${state}`,
    },
    "manual"
  );
  if (!run.ok) throw new Error(`run: ${run.error.message}`);
  console.log(
    `RUN STARTED ${run.data.id} · ${boot.data.promptCount} prompts · est $${estimated.toFixed(2)} · project ${boot.data.projectId} · launch ${launchId}`
  );
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
