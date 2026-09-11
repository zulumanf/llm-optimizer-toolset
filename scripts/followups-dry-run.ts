/**
 * Spec 127 / copy v2: DRY RUN of the competitive-mismatch follow-up cohort.
 * Reads only. Prints the sequence counts by state, then for every sequence
 * whose next touch falls within the next N days (default 7) renders the
 * touch exactly as the worker would right now (branch decided now, frozen
 * evidence, entity wording, report state, QA) and writes every rendered
 * draft to a review file. The console gets counts plus a few representative
 * examples — not the whole cohort.
 *
 * Run: npx tsx scripts/followups-dry-run.ts [--days 7] [--examples 3] [--out .local-data/followups-dry-run.md]
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sql } from "@/db/client";
import { wallClock } from "@/lib/prospects/business-days";
import {
  getFollowupSequence,
  listFollowupSequences,
  projectedSlot,
  prospectEntityType,
  renderNextTouch,
  sequenceExpired,
  sequenceExpiresAt,
  type FollowupSequenceView,
  type RenderedTouch,
} from "@/lib/prospects/followups";

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
}
const DAYS = Number(arg("days", "7"));
const EXAMPLES = Number(arg("examples", "3"));
const OUT = arg("out", `.local-data/followups-dry-run-${new Date().toISOString().slice(0, 10)}.md`);

function local(d: Date | null, tz: string): string {
  if (!d) return "-";
  const w = wallClock(d, tz);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][w.weekday];
  return `${day} ${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")} ${tz.split("/")[1]?.replace("_", " ")}`;
}

interface Row {
  view: FollowupSequenceView;
  entityType: string;
  slot: Date | null;
  touch: RenderedTouch | null;
  expired: boolean;
}

async function main(): Promise<void> {
  const now = new Date();
  const views = await listFollowupSequences({}, now);
  const byState = new Map<string, number>();
  for (const v of views) byState.set(v.displayState, (byState.get(v.displayState) ?? 0) + 1);

  const horizon = new Date(now.getTime() + DAYS * 86_400_000);
  const rows: Row[] = [];
  for (const v of views) {
    const seq = await getFollowupSequence(v.sequenceId);
    if (!seq) continue;
    const et = (await prospectEntityType(seq.evidenceSnapshot)) ?? "UNKNOWN";
    // Paused sequences are projected as if resumed now, so the founder sees
    // what would go out on resume.
    const active = { ...seq, status: "active" as const };
    const slot = seq.nextTouch ? projectedSlot(active, now) : null;
    if (seq.status === "complete" || seq.status === "stopped" || seq.status === "replied") {
      rows.push({ view: v, entityType: et, slot: null, touch: null, expired: false });
      continue;
    }
    const expired = slot ? sequenceExpired(seq.touch1SentAt, slot) : false;
    const due = slot !== null && slot.getTime() <= horizon.getTime();
    const touch = due && !expired ? await renderNextTouch(active, now) : null;
    rows.push({ view: v, entityType: et, slot, touch, expired });
  }

  const due = rows.filter((r) => r.touch);
  const counts = {
    sequences: views.length,
    active: views.filter((v) => v.status === "active").length,
    paused: views.filter((v) => v.status === "paused").length,
    t2Due: due.filter((r) => r.view.nextTouch === 2).length,
    t3Due: due.filter((r) => r.view.nextTouch === 3).length,
    replied: (byState.get("REPLIED") ?? 0) + (byState.get("REPLY_NEEDS_REVIEW") ?? 0),
    needsReview: byState.get("REPLY_NEEDS_REVIEW") ?? 0,
    bounced: byState.get("BOUNCED") ?? 0,
    ooo: byState.get("OOO_PAUSED") ?? 0,
    suppressed: byState.get("SUPPRESSED") ?? 0,
    stopped: byState.get("STOPPED") ?? 0,
    complete: byState.get("COMPLETE_NO_REPLY") ?? 0,
    expiredAtSlot: rows.filter((r) => r.expired).length,
    qaPass: due.filter((r) => r.touch!.qa.length === 0).length,
    qaFail: due.filter((r) => r.touch!.qa.length > 0).length,
    byBranch: {} as Record<string, number>,
    byEntity: {} as Record<string, number>,
    byDay: {} as Record<string, number>,
  };
  for (const r of due) {
    const key = `T${r.view.nextTouch} ${r.touch!.branch}`;
    counts.byBranch[key] = (counts.byBranch[key] ?? 0) + 1;
    counts.byEntity[r.entityType] = (counts.byEntity[r.entityType] ?? 0) + 1;
    const day = local(r.slot, r.view.timezone).slice(0, 14);
    counts.byDay[day] = (counts.byDay[day] ?? 0) + 1;
  }

  // Review file: every rendered draft with its verification fields.
  const lines: string[] = [
    `# Follow-up dry run — ${now.toISOString()}`, ``,
    `Sequences ${counts.sequences} · active ${counts.active} · paused ${counts.paused} · due within ${DAYS}d: T2 ${counts.t2Due}, T3 ${counts.t3Due} · QA pass ${counts.qaPass} / fail ${counts.qaFail}`, ``,
    `## Sequences by state`, ``,
    ...[...byState.entries()].sort().map(([k, n]) => `- ${k}: ${n}`), ``,
    `## Not due within ${DAYS} days`, ``,
    ...rows.filter((r) => !r.touch).map((r) => `- ${r.view.displayState.padEnd(18)} ${r.view.businessName} (${r.view.market.split(" — ")[0]}) · ${r.entityType} · next ${r.view.nextTouch ? `T${r.view.nextTouch} ${local(r.slot, r.view.timezone)}` : "-"}${r.expired ? " · EXPIRED AT SLOT" : ""}${r.view.stopReason ? ` · ${r.view.stopReason}` : ""}${r.view.handoff ? ` · HANDOFF: ${r.view.handoff.reportState} — ${r.view.handoff.nextAction}` : ""}`), ``,
    `## Due within ${DAYS} days — rendered as of now`, ``,
  ];
  for (const r of due) {
    const t = r.touch!;
    const v = r.view;
    const s = (await getFollowupSequence(v.sequenceId))!;
    lines.push(
      `### ${v.businessName} — Touch ${v.nextTouch} · ${t.branch} · ${t.qa.length ? "QA FAIL" : "QA ok"}`, ``,
      `- Market: ${v.market.split(" — ")[0]} · tz ${v.timezone}`,
      `- Entity type: ${r.entityType}`,
      `- Competitor: ${v.competitor}`,
      `- Frozen: ${s.evidenceSnapshot.prospect.productionDisplay} vs ${s.evidenceSnapshot.competitor.productionDisplay} · ${s.evidenceSnapshot.prospect.recommendationCount}/${s.evidenceSnapshot.answerCount} vs ${s.evidenceSnapshot.competitor.recommendationCount}/${s.evidenceSnapshot.answerCount} · ${s.distinctCompetitorQuestions} distinct questions`,
      `- Engagement now: ${t.engagement.state} (${t.engagement.reason}; credible ${t.engagement.credibleOpens}, discounted ${t.engagement.discountedOpens})`,
      `- Template: ${t.version}${t.claimVariant ? ` · ${t.claimVariant}` : ""}`,
      `- Scheduled (recipient-local, before cap deferral): ${local(r.slot, v.timezone)} · expires ${local(sequenceExpiresAt(s.touch1SentAt), v.timezone)}`,
      `- Thread: ${t.newThread ? "NEW thread" : "reply in existing thread"} · subject "${t.subject}"`,
      `- Status: ${v.displayState}${v.status === "paused" ? " (paused — projected as if resumed)" : ""}`,
      t.qa.length ? `- QA: ${t.qa.map((i) => `[${i.check}] ${i.detail}`).join(" ")}` : `- QA: pass`,
      ``, "```", t.body, "```", ``
    );
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, lines.join("\n"));

  // Console: counts + representative examples.
  console.log(JSON.stringify(counts, null, 2));
  console.log(`\nreview file: ${OUT}`);
  const shown = new Set<string>();
  for (const r of due) {
    const key = `T${r.view.nextTouch}-${r.touch!.branch}-${r.entityType}`;
    if (shown.has(key) || shown.size >= EXAMPLES * 2) continue;
    shown.add(key);
    console.log(`\n=== ${r.view.businessName} · T${r.view.nextTouch} ${r.touch!.branch} · ${r.entityType} · ${r.view.competitor} · ${local(r.slot, r.view.timezone)} · ${r.touch!.newThread ? "NEW thread" : "in-thread"} · QA ${r.touch!.qa.length ? "FAIL" : "ok"}`);
    console.log(r.touch!.body.split("\n--\n")[0]!.split("\n").map((l) => `  | ${l}`).join("\n"));
  }
  const failures = due.filter((r) => r.touch!.qa.length);
  if (failures.length) {
    console.log(`\nQA FAILURES ${failures.length}`);
    for (const r of failures) console.log(`  ${r.view.businessName}: ${r.touch!.qa.map((i) => i.detail).join(" ")}`);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
