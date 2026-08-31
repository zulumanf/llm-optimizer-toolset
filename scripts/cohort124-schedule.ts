/**
 * Cohort-124 final render QA + 3-day scheduling (2026-08-31), founder-
 * approved. For each of the 50 locked rows:
 *
 *   regenerate draft (corrected public-website footer) → full render QA
 *   (qaDraft incl. signature_domain, subject shape, subject↔body market
 *   consistency, artifact scan) → balanced 17/17/16 day assignment
 *   (markets round-robined across days) → deterministic 09:00–10:30
 *   recipient-local dispersion → freeze schedule into the cohort file →
 *   approveOutreachDraft (hard QA gate) → scheduleDraftSend.
 *
 * --dry runs everything except approve/schedule.
 * Run: npx tsx scripts/cohort124-schedule.ts [--dry]
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import {
  OUTREACH_FORBIDDEN_FOOTER_HOST,
  OUTREACH_PUBLIC_WEBSITE,
} from "@/lib/prospects/constants";
import {
  approveOutreachDraft,
  createOutreachDraft,
  scheduleDraftSend,
} from "@/lib/prospects/service";
import { qaDraft } from "@/lib/prospects/draft-qa";

const EXPERIMENT_ID = "competitive_mismatch_bootstrap_test_001";
const TEMPLATE = "competitive_mismatch_reply_v1";
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03"] as const;
const DAY_CAPS = [17, 17, 16] as const;
/** September = daylight time everywhere in the cohort. Indianapolis and
 * East Tennessee are Eastern; St. Louis Central; Colorado Springs
 * Mountain; Reno Pacific. */
const MARKET_TZ: Record<string, { tz: string; utcOffsetHours: number }> = {
  "Greenville, SC": { tz: "America/New_York", utcOffsetHours: -4 },
  "Raleigh, NC": { tz: "America/New_York", utcOffsetHours: -4 },
  "Virginia Beach, VA": { tz: "America/New_York", utcOffsetHours: -4 },
  "Richmond, VA": { tz: "America/New_York", utcOffsetHours: -4 },
  "Grand Rapids, MI": { tz: "America/Detroit", utcOffsetHours: -4 },
  "Knoxville, TN": { tz: "America/New_York", utcOffsetHours: -4 },
  "Indianapolis, IN": { tz: "America/Indiana/Indianapolis", utcOffsetHours: -4 },
  "St. Louis, MO": { tz: "America/Chicago", utcOffsetHours: -5 },
  "Colorado Springs, CO": { tz: "America/Denver", utcOffsetHours: -6 },
  "Reno, NV": { tz: "America/Los_Angeles", utcOffsetHours: -7 },
};
const ARTIFACT_RE = /\bnull\b|undefined|\{\{|\[object|NaN|<\/?[a-z]+>|&[a-z]+;|<svg/i;
const TITLE_RE = /^(Dr|Mr|Mrs|Ms|Team|Realtor)\.?$/i;

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  const file = ".local-data/realtrends/cohort124-bootstrap-test-001.json";
  const cohort = JSON.parse(readFileSync(file, "utf8"));
  const failures: string[] = [];

  // 1. Regenerate with corrected footer + render QA.
  for (const row of cohort.rows) {
    const [contact] = await sql`
      select id, name from prospect_contacts
      where prospect_id = ${row.prospectId} and is_primary and not do_not_contact and archived_at is null`;
    if (!contact) { failures.push(`${row.entity}: no primary contact`); continue; }
    const gen = await createOutreachDraft(user, {
      prospectId: row.prospectId,
      channel: "email",
      contactId: contact.id as string,
    });
    if (!gen.ok) { failures.push(`${row.entity}: regen failed — ${gen.error.message}`); continue; }
    const draftId = gen.data.draftId as string;
    const [d] = await sql`
      select subject, body, prompt_version from outreach_drafts where id = ${draftId}`;
    const subject = d!.subject as string;
    const body = d!.body as string;
    if (d!.promptVersion !== TEMPLATE) failures.push(`${row.entity}: template ${d!.promptVersion}`);
    const qa = await qaDraft(draftId);
    if (qa.length > 0) failures.push(`${row.entity}: qaDraft ${qa.map((i) => i.check).join(",")}`);
    // subject: "First — Market" with a clean conversational first name
    const m = subject.match(/^(\S+(?: \S+)?) — (.+)$/);
    if (!m) failures.push(`${row.entity}: subject shape "${subject}"`);
    else {
      const first = m[1]!;
      const marketToken = m[2]!;
      if (TITLE_RE.test(first.split(" ")[0]!)) failures.push(`${row.entity}: title in first-name slot "${subject}"`);
      if (/\d|@|\./.test(first)) failures.push(`${row.entity}: malformed first name "${first}"`);
      if (!body.includes(`${marketToken} buyer and seller questions`))
        failures.push(`${row.entity}: subject market "${marketToken}" not in body scope`);
      if (!body.startsWith(`${first} —`)) failures.push(`${row.entity}: greeting != subject first name`);
    }
    if (/ {2,}|\n{3,}/.test(subject)) failures.push(`${row.entity}: whitespace artifact in subject`);
    const core = body.split("\n\n—\n")[0] ?? body;
    if (ARTIFACT_RE.test(core.replace(/&amp;/g, ""))) failures.push(`${row.entity}: body artifact`);
    const footer = body.slice(body.lastIndexOf("\n—\n"));
    if (!footer.includes(OUTREACH_PUBLIC_WEBSITE)) failures.push(`${row.entity}: footer missing public site`);
    if (footer.toLowerCase().includes(OUTREACH_FORBIDDEN_FOOTER_HOST)) failures.push(`${row.entity}: footer shows app host`);
    if ((body.match(/—\nFrancisco/g) ?? []).length !== 1) failures.push(`${row.entity}: footer count != 1`);
    if (!MARKET_TZ[row.market]) failures.push(`${row.entity}: unresolved timezone for ${row.market}`);
    row.draftId = draftId;
    row.subject = subject;
    row.body = body;
    row.firstName = (contact.name as string).split(/\s+/)[0];
    row.qaStatus = qa.length === 0 ? "FINAL_RENDER_QA_PASS" : "FINAL_RENDER_QA_FAIL";
  }
  if (failures.length > 0) {
    console.log("FAILURES — nothing approved or scheduled:");
    for (const f of failures) console.log("  " + f);
    writeFileSync(file, JSON.stringify(cohort, null, 2));
    await sql.end();
    process.exit(1);
  }

  // 2. Balanced day assignment: group by market, round-robin days so every
  // market spreads; respect 17/17/16.
  const byMarket = new Map<string, typeof cohort.rows>();
  for (const row of cohort.rows) {
    if (!byMarket.has(row.market)) byMarket.set(row.market, []);
    byMarket.get(row.market)!.push(row);
  }
  const dayRows: (typeof cohort.rows)[] = [[], [], []];
  let cursor = 0;
  const marketsSorted = [...byMarket.keys()].sort(
    (a, b) => byMarket.get(b)!.length - byMarket.get(a)!.length || a.localeCompare(b)
  );
  for (const market of marketsSorted) {
    const rows = byMarket.get(market)!;
    rows.sort((a: { entity: string }, b: { entity: string }) => a.entity.localeCompare(b.entity));
    for (const row of rows) {
      let day = cursor % 3;
      let hops = 0;
      while (dayRows[day]!.length >= DAY_CAPS[day]! && hops < 3) { day = (day + 1) % 3; hops += 1; }
      dayRows[day]!.push(row);
      cursor += 1;
    }
  }

  // 3. Deterministic local-time dispersion 09:00–10:30, east → west so UTC
  // order is stable, then approve + schedule.
  const schedule: Record<string, unknown>[] = [];
  for (let di = 0; di < 3; di += 1) {
    const rows = dayRows[di]!;
    rows.sort((a: { market: string; entity: string }, b: { market: string; entity: string }) =>
      MARKET_TZ[b.market]!.utcOffsetHours - MARKET_TZ[a.market]!.utcOffsetHours ||
      a.entity.localeCompare(b.entity)
    );
    const n = rows.length;
    for (let i = 0; i < n; i += 1) {
      const row = rows[i]!;
      const offsetMin = n === 1 ? 3 : 3 + Math.round((i * 85) / (n - 1));
      const localH = 9 + Math.floor(offsetMin / 60);
      const localM = offsetMin % 60;
      const tz = MARKET_TZ[row.market]!;
      const utc = new Date(
        Date.UTC(2026, 8, Number(DAYS[di]!.slice(-2)), localH - tz.utcOffsetHours, localM)
      );
      const local = `${String(localH).padStart(2, "0")}:${String(localM).padStart(2, "0")}`;
      row.sendDay = DAYS[di];
      row.sendLocalTime = local;
      row.sendTimezone = tz.tz;
      row.sendUtc = utc.toISOString();
      schedule.push({ day: DAYS[di], entity: row.entity, market: row.market, local, tz: tz.tz, utc: row.sendUtc });
      if (!dry) {
        const approved = await approveOutreachDraft(user, { draftId: row.draftId });
        if (!approved.ok) { failures.push(`${row.entity}: approve — ${approved.error.message}`); continue; }
        const sched = await scheduleDraftSend(user, {
          draftId: row.draftId,
          sendAt: utc,
          businessPurpose:
            `Experiment ${EXPERIMENT_ID}: founder-approved Touch 1 (${TEMPLATE}) to a competitively mismatched ` +
            `real-estate ${row.entityType === "team" ? "team" : "agent"} in ${row.market}, evidence-frozen.`,
        });
        if (!sched.ok) failures.push(`${row.entity}: schedule — ${sched.error.message}`);
      }
    }
  }

  // 4. Trailing-24h transport-cap simulation across the whole plan.
  const utcs = schedule.map((s) => new Date(s.utc as string).getTime()).sort((a, b) => a - b);
  let worst = 0;
  for (const t of utcs) {
    const inWindow = utcs.filter((x) => x <= t && x > t - 24 * 3600 * 1000).length;
    worst = Math.max(worst, inWindow);
  }
  console.log(`trailing-24h worst case: ${worst} (cap 25)`);

  cohort.experiment = {
    id: EXPERIMENT_ID,
    template: TEMPLATE,
    kpi: "positive human replies / delivered prospects",
    lockedAt: new Date().toISOString(),
    scheduledCounts: dayRows.map((r) => r.length),
  };
  cohort.status = dry ? "READY_FOR_FOUNDER_APPROVAL" : failures.length === 0 ? "SCHEDULED" : "PARTIALLY_SCHEDULED";
  writeFileSync(file, JSON.stringify(cohort, null, 2));
  console.log(`days: ${dayRows.map((r) => r.length).join(" / ")} · dry=${dry}`);
  if (failures.length > 0) {
    console.log("FAILURES:");
    for (const f of failures) console.log("  " + f);
    process.exit(1);
  }
  console.log(`50/50 ${dry ? "render-QA validated (nothing approved/scheduled)" : "approved + scheduled"}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
