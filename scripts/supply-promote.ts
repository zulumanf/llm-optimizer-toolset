/**
 * Supply engine promotion (2026-09-13): a RealTrends-only entity earns a
 * prospect record ONLY after its decision-maker contact is verified on a
 * public page. Input JSON (array) at --file:
 *   { sourceRecordId, person, role, email, sourceUrl, notes? }
 *
 * Per row, in order, each step idempotent and fail-closed:
 *   1. re-verify the literal email on the source page (contact-verify);
 *      generic inboxes are refused — a Touch 1 needs a person
 *   2. company: reuse the record's linked company or upsert one by name,
 *      then confirmDatasetMatch (production becomes dataset-verified)
 *   3. prospect: reuse the launch's prospect for that company / exact name,
 *      else createProspect (source: research, provenance stamped)
 *   4. contact: reuse an identical email, else addContact publicly_sourced
 *      (primary) + activity note with the source URL
 *   5. attach the company to the market benchmark project as a competitor
 *      entity so the frozen run's answers resolve it (backfill) — SKIPPED
 *      while a run on that project is pending/running (mid-run edits are
 *      never safe); rerun after the run completes.
 * Nothing here drafts, schedules, sends, or starts a run.
 *
 * Run: DATABASE_URL=<direct url> npx tsx scripts/supply-promote.ts --file <path>
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { upsertCompany } from "@/lib/companies/service";
import { addCompetitor } from "@/lib/competitors/service";
import { emailOnPage, emailOnRenderedPage } from "@/lib/prospects/contact-verify";
import { withRenderer } from "@/lib/prospects/contact-render";
import { enqueueCompanyBackfill } from "@/lib/parsing/backfill";
import { confirmDatasetMatch, launchGeographies } from "@/lib/prospects/realtrends-dataset";
import { addActivityNote, addContact, createProspect, updateProspect } from "@/lib/prospects/service";
import { promotionIdentityCheck } from "@/lib/prospects/supply-engine";
import { isGenericEmail } from "@/lib/prospects/t1-cohort";

/** Either a RealTrends-only entity (sourceRecordId) or an existing prospect
 * that lacked a sendable contact (prospectId) — the contact step is the same. */
interface Row { sourceRecordId?: string; prospectId?: string; person: string; role: string | null; email: string; sourceUrl: string; sourceType?: string; notes?: string }

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

/** Identity fails closed: a machine match (high_confidence) to a company
 * whose name is not the record's entity name is NOT promoted — it goes to
 * the dataset review queue (a team record matched to a person company was
 * the 2026-09-14 Lipschutz case). Only an exact-name company or a
 * human-confirmed match proceeds. */
async function ensureCompany(user: CurrentUser, record: { id: string; entityName: string; entityType: "individual" | "team"; companyId: string | null; matchStatus: string }): Promise<string> {
  let companyId = record.companyId;
  if (companyId) {
    const [co] = await sql`
      select c.name, (select p.prospect_type from prospects p where p.company_id = c.id and p.archived_at is null order by p.created_at limit 1) as measured
      from companies c where c.id = ${companyId}`;
    const measured = co?.measured === "team" ? "team" : co?.measured === "individual_agent" ? "individual" : co?.measured === "brokerage" ? "brokerage" : null;
    const verdict = promotionIdentityCheck(record, co ? { name: co.name as string, measuredLevel: measured } : null);
    if (!verdict.ok) throw new Error(`identity review (${verdict.reason}): ${verdict.detail} — resolve in the RealTrends review queue first`);
  }
  if (!companyId) {
    const [existing] = await sql`select id from companies where lower(name) = ${record.entityName.toLowerCase()} and archived_at is null limit 1`;
    if (existing) companyId = existing.id as string;
    else {
      const res = await upsertCompany(user, { name: record.entityName.slice(0, 80) });
      if (!res.ok) throw new Error(`company: ${res.error.message}`);
      companyId = res.data.id;
    }
  }
  if (record.matchStatus !== "confirmed" || record.companyId !== companyId) {
    const res = await confirmDatasetMatch(user, { recordId: record.id, companyId });
    if (!res.ok) throw new Error(`dataset match: ${res.error.message}`);
  }
  return companyId;
}

async function ensureProspect(user: CurrentUser, launchId: string, companyId: string, r: Record<string, unknown>): Promise<{ prospectId: string; created: boolean }> {
  const [existing] = await sql`
    select id from prospects where launch_id = ${launchId} and archived_at is null
      and (company_id = ${companyId} or lower(business_name) = ${(r.entityName as string).toLowerCase()}) limit 1`;
  if (existing) return { prospectId: existing.id as string, created: false };
  const res = await createProspect(user, {
    launchId, companyId, businessName: r.entityName, prospectType: r.entityType === "team" ? "team" : "individual_agent",
    brokerageAffiliation: (r.brokerage as string | null) ?? undefined, teamLeader: (r.teamLead as string | null) ?? undefined,
    estTransactionVolumeUsd: r.volumeUsd === null ? undefined : Math.round(Number(r.volumeUsd)), source: "research",
    fieldProvenance: { businessName: "verified", brokerageAffiliation: "verified", teamLeader: "verified", estTransactionVolumeUsd: "verified" },
    notes: `Promoted by the supply engine from RealTrends record ${r.id as string} (licensed dataset, production year ${r.productionYear as number}).`,
  });
  if (!res.ok) throw new Error(`prospect: ${res.error.message}`);
  return { prospectId: res.data.prospectId, created: true };
}

async function ensureContact(user: CurrentUser, prospectId: string, row: Row): Promise<boolean> {
  const [existing] = await sql`select id from prospect_contacts where prospect_id = ${prospectId} and lower(email) = ${row.email.toLowerCase()} and archived_at is null limit 1`;
  if (existing) return false;
  const res = await addContact(user, { prospectId, name: row.person, role: row.role ?? undefined, email: row.email, isPrimary: true, provenance: "publicly_sourced", notes: `email source: ${row.sourceUrl}${row.notes ? `\n${row.notes}` : ""}` });
  if (!res.ok) throw new Error(`contact: ${res.error.message}`);
  await updateProspect(user, { prospectId, email: row.email, fieldProvenance: { email: "publicly_sourced" } });
  await addActivityNote(user, { prospectId, note: `contact_verified: ${row.email} appears literally on ${row.sourceUrl} (supply engine ${new Date().toISOString().slice(0, 10)})` });
  return true;
}

/** Benchmark classifier availability from the cached preflight (30-minute
 * TTL). A backfill re-parses whole frozen runs through the LLM classifier;
 * while the provider is CAPACITY_BLOCKED that re-parse would delete good
 * parses and rewrite them with the heuristic fallback (observed 2026-09-14
 * on the Wilmington project), so attaches are recorded WITHOUT backfill
 * and the reparse is deferred until the provider is available. */
function classifierAvailable(): boolean {
  try {
    const rows = JSON.parse(readFileSync(".local-data/supply/provider-status.json", "utf8")) as { provider: string; state: string; observedAt: string }[];
    const openai = rows.find((r) => r.provider === "openai");
    if (!openai || Date.now() - new Date(openai.observedAt).getTime() > 30 * 60_000) return false; // stale or absent: fail closed, defer
    return openai.state === "AVAILABLE";
  } catch { return false; }
}

/** (project, company) pairs attached in this batch; ONE backfill job each at the end. */
const pendingBackfill = new Map<string, { projectId: string; companyId: string }>();

/**
 * Resolve the launch's benchmark project by CANONICAL market identity
 * (projects.market_id = the launch's markets.id). A launch whose market has
 * no bound project — including a legacy project that still shares its
 * display name across states — is refused, never guessed: an attach in
 * Wilmington, NC can therefore never touch Wilmington, DE runs.
 */
async function attachToBenchmark(user: CurrentUser, launchId: string, companyId: string): Promise<string> {
  const [launch] = await sql`select market_id from market_launches where id = ${launchId}`;
  if (!launch) return "NO_LAUNCH";
  const [project] = await sql`
    select p.id from projects p where p.market_id = ${launch.marketId} and p.archived_at is null
      and exists (select 1 from runs r where r.project_id = p.id and r.status in ('completed', 'partial'))`;
  if (!project) {
    const [legacy] = await sql`
      select p.id from prospects pr join prospect_benchmarks pb on pb.prospect_id = pr.id join runs r on r.id = pb.run_id join projects p on p.id = r.project_id
      where pr.launch_id = ${launchId} and p.market_id is null and p.archived_at is null limit 1`;
    return legacy ? `PROJECT_MARKET_REVIEW_REQUIRED (legacy project ${legacy.id as string} is not bound to a market; bind or split it first)` : "NO_BENCHMARK_PROJECT";
  }
  const projectId = project.id as string;
  const [inFlight] = await sql`select 1 from runs where project_id = ${projectId} and status in ('pending','running') limit 1`;
  if (inFlight) return "DEFERRED_RUN_IN_FLIGHT";
  const [already] = await sql`select 1 from competitors where project_id = ${projectId} and company_id = ${companyId} and archived_at is null limit 1`;
  if (already) return "ALREADY_ATTACHED";
  const res = await addCompetitor(user, { projectId, companyId, tier: "secondary", backfill: false });
  if (!res.ok) return `ATTACH_FAILED: ${res.error.message}`;
  pendingBackfill.set(`${projectId}:${companyId}`, { projectId, companyId });
  return classifierAvailable() ? "ATTACHED (one company-scoped backfill job queued at end of batch)" : "ATTACHED_BACKFILL_DEFERRED (classifier provider blocked — enqueue when AVAILABLE)";
}

/** One idempotent, company-scoped backfill job per attached pair. Nothing is
 * deleted or re-classified; duplicates are deduplicated against the queue. */
async function flushBackfills(): Promise<void> {
  if (pendingBackfill.size === 0) return;
  if (!classifierAvailable()) { console.log(`backfill deferred for ${pendingBackfill.size} attach(es): classifier provider blocked (run scripts/provider-preflight.ts, then re-run this file when AVAILABLE)`); return; }
  for (const { projectId, companyId } of pendingBackfill.values()) {
    const q = await enqueueCompanyBackfill(projectId, companyId, "competitor_attach");
    console.log(`backfill ${projectId} ← ${companyId}: job ${q.jobId}${q.deduplicated ? " (already queued)" : ""} · scope ${q.estimate.runs} run(s), ${q.estimate.responses} answer(s) scanned, classifier calls only where the company is named`);
  }
}

async function main(): Promise<void> {
  const file = arg("--file");
  if (!file) throw new Error("--file <path> is required");
  const rows = JSON.parse(readFileSync(file, "utf8")) as Row[];
  const user = await operatorUser();
  const geos = await launchGeographies(sql);
  for (const row of rows) {
    const tag = `${row.person} <${row.email}>`;
    if (isGenericEmail(row.email)) { console.log(`REFUSED generic inbox ${tag}`); continue; }
    // Literal verification: plain fetch first; a page that only yields its
    // contact card after rendering is re-checked in the rendered DOM (the
    // same literal rule, provenance noted). A search snippet never counts.
    let literal = emailOnPage(row.sourceUrl, row.email);
    if (!literal && row.sourceType === "rendered_page") {
      literal = await emailOnRenderedPage(row.sourceUrl, row.email);
      if (literal) row.notes = `${row.notes ? `${row.notes}\n` : ""}verification: literal in the rendered DOM (JS-served public page)`;
    }
    if (!literal) { console.log(`REFUSED not on page ${tag} ${row.sourceUrl}`); continue; }
    if (row.prospectId) {
      const [pp] = await sql`select business_name, launch_id, company_id from prospects where id = ${row.prospectId} and archived_at is null`;
      if (!pp) { console.log(`REFUSED unknown prospect ${row.prospectId}`); continue; }
      const added = await ensureContact(user, row.prospectId, row);
      const attach = pp.companyId ? await attachToBenchmark(user, pp.launchId as string, pp.companyId as string) : "NO_COMPANY_LINK";
      console.log(`${pp.businessName as string} → prospect ${row.prospectId} existing · contact ${added ? "added" : "reused"} · benchmark ${attach}`);
      continue;
    }
    const [rec] = await sql`select id, entity_type, entity_name, team_lead, brokerage, city, state, volume_usd, production_year, company_id, match_status from realtrends_records where id = ${row.sourceRecordId ?? ""}`;
    if (!rec) { console.log(`REFUSED unknown RealTrends record ${String(row.sourceRecordId)}`); continue; }
    const geo = geos.find((g) => g.state && g.city.toLowerCase() === (rec.city as string).toLowerCase() && g.state === rec.state);
    if (!geo) { console.log(`REFUSED no launch for ${rec.city as string}, ${rec.state as string} (outbound requires a founder-created launch)`); continue; }
    let companyId: string;
    try {
      companyId = await ensureCompany(user, { id: rec.id as string, entityName: rec.entityName as string, entityType: rec.entityType as "individual" | "team", companyId: (rec.companyId as string | null) ?? null, matchStatus: rec.matchStatus as string });
    } catch (e) { console.log(`REFUSED ${rec.entityName as string}: ${(e as Error).message}`); continue; }
    const prospect = await ensureProspect(user, geo.launchId, companyId, rec as Record<string, unknown>);
    const contactAdded = await ensureContact(user, prospect.prospectId, row);
    const attach = await attachToBenchmark(user, geo.launchId, companyId);
    console.log(`${rec.entityName as string} (${rec.entityType as string}, ${rec.city as string} ${rec.state as string}) → prospect ${prospect.prospectId} ${prospect.created ? "created" : "reused"} · contact ${contactAdded ? "added" : "reused"} · benchmark ${attach}`);
  }
  await flushBackfills();
}

// withRenderer: the headless browser closes on every exit path; sql.end in
// finally so the process exits promptly (hardening 2026-09-14).
withRenderer(main).finally(() => sql.end()).catch((e) => { console.error(e); process.exit(1); });
