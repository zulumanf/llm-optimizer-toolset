/**
 * Cohort-124 final pre-send audit (2026-08-31). Deterministic revalidation of
 * every SEND_READY row against canonical data — no rendered value trusted:
 *
 *  1. draft integrity: latest draft, template version, frozen snapshot;
 *  2. qaDraft (re-proves frozen claims vs live counts, eligibility, recency);
 *  3. RealTrends canonical: prospect + competitor rows re-read from
 *     realtrends_records via company match — type, year, volume, state,
 *     inversion, gap threshold; snapshot values must equal canonical;
 *  4. benchmark semantics: denominator == count of error-free openai
 *     responses in the run; counts via providerRecommendationCounts;
 *  5. proven-zero: for 0-rec prospects, every alias hit in the run's openai
 *     answers has a max-revision mention with recommended=false, and no
 *     pending review rows exist for the company in the run;
 *  6. policy re-check: prior sends, suppression, DNC, cross-prospect
 *     recontact, duplicate emails inside the cohort;
 *  7. rendering artifacts + subject + footer;
 *  8. concentration + brokerage-string normalization analytics.
 *
 * Read-only except the refreshed cohort JSON. Nothing approved or sent.
 * Run: npx tsx scripts/cohort124-final-audit.ts
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import { checkSuppression } from "@/lib/outreach/suppression";
import { MISMATCH_THRESHOLDS } from "@/lib/prospects/constants";
import { providerRecommendationCounts } from "@/lib/prospects/benchmark";
import { competitiveMismatchReview } from "@/lib/prospects/mismatch";
import { qaDraft } from "@/lib/prospects/draft-qa";
import { scanAliases } from "@/lib/parsing/prepass";

const ARTIFACT_RE = /\bnull\b|undefined|\{\{|\[object|NaN|<\/?[a-z]+>|&[a-z]+;/i;

interface Issue {
  entity: string;
  check: string;
  detail: string;
}

async function main(): Promise<void> {
  const file = ".local-data/realtrends/cohort124-bootstrap-test-001.json";
  const cohort = JSON.parse(readFileSync(file, "utf8"));
  const issues: Issue[] = [];
  const warn = (entity: string, check: string, detail: string) =>
    issues.push({ entity, check, detail });

  const seenEmails = new Map<string, string>();
  const seenCompanies = new Map<string, string>();
  const perComp = new Map<string, number>();
  const perBrk = new Map<string, number>();
  let zerosProven = 0;
  let zeroRows = 0;

  for (const row of cohort.rows) {
    const entity = row.entity as string;
    // -- latest draft for the prospect (swaps created new versions)
    const [draft] = await sql`
      select d.id, d.subject, d.body, d.prompt_version, d.status, d.contact_id,
        d.evidence_snapshot
      from outreach_drafts d
      where d.prospect_id = ${row.prospectId} and d.channel = 'email'
      order by d.version desc limit 1`;
    if (!draft) { warn(entity, "draft", "no draft found"); continue; }
    if (draft.status !== "draft") warn(entity, "draft", `status is ${draft.status}, expected unapproved draft`);
    if (draft.promptVersion !== "competitive_mismatch_reply_v1")
      warn(entity, "template", `prompt_version ${draft.promptVersion}`);
    const snap = draft.evidenceSnapshot as {
      runId: string; provider: string; answerCount: number;
      prospect: { companyId: string; name: string; recommendationCount: number; productionValue: number; productionYear: number | null };
      competitor: { companyId: string; name: string; recommendationCount: number; productionValue: number; productionYear: number | null };
    } | null;
    if (!snap) { warn(entity, "snapshot", "no frozen evidence snapshot"); continue; }
    if (snap.provider !== "openai") warn(entity, "provider", `snapshot provider ${snap.provider}`);

    // -- deterministic draft QA (frozen vs live)
    const qa = await qaDraft(draft.id as string);
    if (qa.length > 0) warn(entity, "qaDraft", qa.map((i) => `${i.check}: ${i.detail}`).join(" | "));

    // -- RealTrends canonical revalidation
    const rt = async (companyId: string) => {
      const rows = await sql`
        select entity_name, entity_type, volume_usd, production_year, city, state
        from realtrends_records where company_id = ${companyId}
        order by production_year desc, volume_usd desc limit 1`;
      return rows[0] ?? null;
    };
    const prt = await rt(snap.prospect.companyId);
    const crt = await rt(snap.competitor.companyId);
    if (!prt) warn(entity, "rt_prospect", "no matched realtrends_records row for prospect company");
    if (!crt) warn(entity, "rt_competitor", "no matched realtrends_records row for competitor company");
    if (prt && crt) {
      if (Number(prt.volumeUsd) !== snap.prospect.productionValue)
        warn(entity, "rt_value", `prospect snapshot ${snap.prospect.productionValue} != canonical ${prt.volumeUsd}`);
      if (Number(crt.volumeUsd) !== snap.competitor.productionValue)
        warn(entity, "rt_value", `competitor snapshot ${snap.competitor.productionValue} != canonical ${crt.volumeUsd}`);
      if (prt.productionYear !== crt.productionYear)
        warn(entity, "rt_period", `years ${prt.productionYear} vs ${crt.productionYear}`);
      if (prt.entityType !== crt.entityType)
        warn(entity, "rt_type", `${prt.entityType} vs ${crt.entityType}`);
      if (prt.state !== crt.state)
        warn(entity, "rt_state", `${prt.city},${prt.state} vs ${crt.city},${crt.state}`);
      if (Number(crt.volumeUsd) >= Number(prt.volumeUsd))
        warn(entity, "rt_inversion", "competitor produces >= prospect");
      else if (Number(crt.volumeUsd) / Number(prt.volumeUsd) > MISMATCH_THRESHOLDS.maxCompetitorProductionRatio)
        warn(entity, "rt_gap", `production ratio ${(Number(crt.volumeUsd) / Number(prt.volumeUsd)).toFixed(2)} above threshold`);
    }

    // -- benchmark semantics
    const [denom] = await sql`
      select count(*)::int as n from responses
      where run_id = ${snap.runId} and provider = 'openai' and error is null`;
    if (Number(denom!.n) !== snap.answerCount)
      warn(entity, "denominator", `snapshot ${snap.answerCount} != ${denom!.n} error-free openai responses`);
    const counts = await providerRecommendationCounts(snap.runId, "openai", [
      snap.prospect.companyId,
      snap.competitor.companyId,
    ]);
    const liveP = counts.recommendedByCompany[snap.prospect.companyId] ?? 0;
    const liveC = counts.recommendedByCompany[snap.competitor.companyId] ?? 0;
    if (liveP !== snap.prospect.recommendationCount)
      warn(entity, "recount_prospect", `live ${liveP} != frozen ${snap.prospect.recommendationCount}`);
    if (liveC !== snap.competitor.recommendationCount)
      warn(entity, "recount_competitor", `live ${liveC} != frozen ${snap.competitor.recommendationCount}`);
    if (liveC - liveP < MISMATCH_THRESHOLDS.minRecommendationGap)
      warn(entity, "rec_gap", `gap ${liveC - liveP} below threshold`);

    // -- proven zero
    if (snap.prospect.recommendationCount === 0) {
      zeroRows += 1;
      const [co] = await sql`select id, name, aliases, domain from companies where id = ${snap.prospect.companyId}`;
      const responses = await sql`
        select id, response_text from responses
        where run_id = ${snap.runId} and provider = 'openai' and error is null`;
      const single = [{ id: co!.id as string, name: co!.name as string, aliases: (co!.aliases as string[]) ?? [], domain: co!.domain as string | null }];
      let ok = true;
      for (const r of responses) {
        if (scanAliases((r.responseText as string) ?? "", single).length === 0) continue;
        const [m] = await sql`
          select recommended, needs_review from mentions
          where response_id = ${r.id} and company_id = ${co!.id}
          order by revision desc limit 1`;
        if (!m) { warn(entity, "zero_unparsed", `alias hit in response ${r.id} has no mention row`); ok = false; break; }
        if (m.recommended) { warn(entity, "zero_false", `response ${r.id} max-revision mention says recommended`); ok = false; break; }
        if (m.needsReview) { warn(entity, "zero_review", `response ${r.id} mention pending review`); ok = false; break; }
      }
      if (ok) zerosProven += 1;
    }

    // -- contact + policy
    const [contact] = await sql`
      select id, name, email, provenance, do_not_contact from prospect_contacts
      where id = ${draft.contactId}`;
    if (!contact?.email) warn(entity, "contact", "draft has no contact email");
    else {
      if (["ai_inferred", "estimated"].includes(contact.provenance as string))
        warn(entity, "provenance", `contact provenance ${contact.provenance}`);
      if (contact.doNotContact) warn(entity, "dnc", "contact is DNC");
      const email = (contact.email as string).toLowerCase();
      if (seenEmails.has(email)) warn(entity, "dup_email", `same email as ${seenEmails.get(email)}`);
      seenEmails.set(email, entity);
      const sup = await checkSuppression({ email, projectId: null });
      if (sup.suppressed) warn(entity, "suppressed", sup.reason ?? "suppressed");
      const [prior] = await sql`
        select 1 from prospect_outreach_sends s
        where s.allowed and (s.prospect_id = ${row.prospectId}
          or lower(s.recipient_email) = ${email})`;
      if (prior) warn(entity, "prior_send", "prior allowed send exists");
      const [sched] = await sql`
        select 1 from outreach_drafts where prospect_id = ${row.prospectId}
          and scheduled_send_at is not null and sent_recorded_at is null`;
      if (sched) warn(entity, "scheduled", "a scheduled send already exists");
    }
    if (seenCompanies.has(snap.prospect.companyId))
      warn(entity, "dup_entity", `same company as ${seenCompanies.get(snap.prospect.companyId)}`);
    seenCompanies.set(snap.prospect.companyId, entity);

    // -- prospect DNC / archived
    const [p] = await sql`select do_not_contact, archived_at from prospects where id = ${row.prospectId}`;
    if (p?.doNotContact) warn(entity, "dnc", "prospect is DNC");
    if (p?.archivedAt) warn(entity, "archived", "prospect archived");

    // -- rendering
    const body = draft.body as string;
    const subject = draft.subject as string;
    const bodyCore = body.split("—\nFrancisco")[0] ?? body;
    if (ARTIFACT_RE.test(bodyCore.replace(/&amp;/g, ""))) {
      const m = bodyCore.match(ARTIFACT_RE);
      warn(entity, "artifact", `body contains "${m?.[0]}"`);
    }
    if (/\b(\w+) \1\b/i.test(subject)) warn(entity, "subject_dup", subject);
    if (!/^[^\n]{2,60} — [^\n]{3,40}$/.test(subject) || /^(Dr|Mr|Mrs|Ms)\.? —/.test(subject)) warn(entity, "subject_shape", subject);
    if (!body.toLowerCase().includes("unsubscribe") && !/if you'd rather not/i.test(body))
      warn(entity, "footer", "no opt-out line");
    if (!body.includes("1399 Myrtle Ave")) warn(entity, "footer", "no postal address");
    if (/team team|group group/i.test(body)) warn(entity, "naming", "duplicated word in names");
    const rev = await competitiveMismatchReview(row.prospectId);
    if (!rev?.evaluation.eligible) warn(entity, "eligibility", "no longer live-eligible");

    // -- concentration tallies
    perComp.set(snap.competitor.name, (perComp.get(snap.competitor.name) ?? 0) + 1);
    const b = ((row.brokerage as string) ?? "").trim().toLowerCase();
    if (b) perBrk.set(b, (perBrk.get(b) ?? 0) + 1);

    // refresh row fields from the latest draft (covers the two swaps)
    row.draftId = draft.id;
    row.subject = subject;
    row.body = body;
    row.firstName = (contact?.name as string | undefined)?.split(/\s+/)[0] ?? row.firstName;
    row.contactName = contact?.name ?? row.contactName;
    row.email = contact?.email ?? row.email;
    row.qaStatus = qa.length === 0 ? "FINAL_QA_PASS" : "FINAL_QA_FAIL";
  }

  console.log(`rows audited: ${cohort.rows.length}`);
  console.log(`zero-count rows: ${zeroRows}, proven zero: ${zerosProven}`);
  console.log(`issues: ${issues.length}`);
  for (const i of issues) console.log(`  [${i.check}] ${i.entity}: ${i.detail.slice(0, 160)}`);
  console.log("\ncompetitor concentration:");
  for (const [c, n] of [...perComp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${c}: ${n}`);
  console.log("brokerage concentration (top):");
  for (const [c, n] of [...perBrk.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${c}: ${n}`);

  cohort.status = issues.length === 0 ? "READY_FOR_FOUNDER_APPROVAL" : "REVIEW_REQUIRED";
  cohort.finalAuditAt = new Date().toISOString();
  cohort.finalAuditIssues = issues;
  writeFileSync(file, JSON.stringify(cohort, null, 2));
  console.log(`\ncohort file updated: status ${cohort.status}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
