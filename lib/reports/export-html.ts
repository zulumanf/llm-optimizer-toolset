/**
 * Client-facing report render (spec 031 follow-up, roadmap 3.3). Same
 * decision as plans: a self-contained printable HTML page and the
 * browser's print-to-PDF, not a server PDF pipeline (recorded in spec
 * 006). Published reports only — rendering a draft would turn an
 * unreviewed composition into a client commitment.
 *
 * Every number rendered here comes from the immutable published snapshot;
 * this module formats, it never recomputes.
 */
import type { ReportBody } from "@/lib/reports/types";
import { NARRATIVE_SECTIONS } from "@/lib/reports/types";
import { METRIC_LABELS } from "@/lib/format";
import { verdictLine } from "@/lib/reports/verdict-language";

const SECTION_LABELS: Record<string, string> = {
  summary: "Executive summary",
  competitors: "Competitive picture",
  notable_responses: "Notable AI answers",
  suggested_actions: "Recommended next steps",
};

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmt(metric: string, value: number): string {
  return metric === "authority_score" ? value.toFixed(1) : pct(value);
}

/**
 * The program section (spec 051, audit F26): what we did and did it work.
 * The data always sat in the immutable snapshot; it was never rendered —
 * the retest verdict the platform exists to produce finally reaches the
 * client. Old bodies without the newer fields render defensively.
 */
function programSection(body: ReportBody): string {
  const program = body.program;
  if (!program) return "";

  const interventionRows = (program.interventions ?? [])
    .map((i) => {
      const line = verdictLine(
        (i.verdictSummaries ?? []).map((v) => ({
          metric: v.metric,
          delta: Number(v.delta),
          verdict: v.verdict,
        }))
      );
      return `
      <tr>
        <td>${esc(i.title)}</td>
        <td class="muted">${esc(i.shippedAt)}</td>
        <td>${esc(line)}</td>
      </tr>`;
    })
    .join("");

  const contentRows = (program.contentPublished ?? [])
    .map(
      (c) => `
      <tr>
        <td>${esc(c.title)}</td>
        <td class="muted">${c.url ? esc(c.url) : "—"}</td>
      </tr>`
    )
    .join("");

  const tasksDone = (program.tasksCompleted ?? []).length;
  const gapCount = (program.gapFindings ?? []).length;

  if (!interventionRows && !contentRows && tasksDone === 0 && gapCount === 0) {
    return "";
  }

  return `<section>
  <h2>What we did — and did it work</h2>
  <p class="muted">${gapCount} finding${gapCount === 1 ? "" : "s"} identified and ${tasksDone} work item${
    tasksDone === 1 ? "" : "s"
  } completed this period. Each shipped change below is re-measured on the
  same instrument that produced its baseline; assessments follow the
  documented change-detection rules.</p>
  ${
    interventionRows
      ? `<table><thead><tr><th>Shipped change</th><th>Shipped</th><th>Did it work?</th></tr></thead>
  <tbody>${interventionRows}</tbody></table>`
      : ""
  }
  ${
    contentRows
      ? `<table><thead><tr><th>Content published</th><th>Where</th></tr></thead>
  <tbody>${contentRows}</tbody></table>`
      : ""
  }
</section>`;
}

export function renderReportHtml(args: {
  clientName: string;
  title: string;
  periodStart: string;
  periodEnd: string;
  publishedAt: string;
  body: ReportBody;
}): string {
  const { body } = args;
  const selfScores = body.scores.filter(
    (s) => s.isSelf && s.provider === "all"
  );
  const selfDeltas = body.deltas.filter((d) => d.isSelf);

  const narrative = NARRATIVE_SECTIONS.filter(
    (s) => (body.narrative[s] ?? "").trim().length > 0
  )
    .map(
      (s) => `
      <section>
        <h2>${esc(SECTION_LABELS[s] ?? s)}</h2>
        <p>${esc(body.narrative[s]!).replace(/\n/g, "<br/>")}</p>
      </section>`
    )
    .join("");

  const scoreRows = selfScores
    .map(
      (s) => `
      <tr>
        <td>${esc(METRIC_LABELS[s.metric] ?? s.metric)}</td>
        <td class="num">${fmt(s.metric, Number(s.value))}</td>
        <td class="num muted">of ${s.sampleSize} answers</td>
      </tr>`
    )
    .join("");

  const deltaRows = selfDeltas
    .map(
      (d) => `
      <tr>
        <td>${esc(METRIC_LABELS[d.metric] ?? d.metric)}</td>
        <td class="num">${fmt(d.metric, Number(d.previous))}${
          d.nPrevious != null ? ` <span class="muted">(n=${d.nPrevious})</span>` : ""
        }</td>
        <td class="num">${fmt(d.metric, Number(d.current))}${
          d.nCurrent != null ? ` <span class="muted">(n=${d.nCurrent})</span>` : ""
        }</td>
        <td class="num">${Number(d.delta) >= 0 ? "+" : ""}${fmt(d.metric, Number(d.delta))}</td>
        <td class="muted">${esc(String(d.verdict ?? ""))}</td>
      </tr>`
    )
    .join("");

  const ownershipRows = body.categoryOwnership
    .map(
      (c) => `
      <tr>
        <td>${esc(c.category)}</td>
        <td>${esc(c.label)}</td>
        <td class="num muted">${c.mentions} of ${c.observations} answers</td>
        <td class="muted">${c.leadingCompetitor ? esc(c.leadingCompetitor) : "—"}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>${esc(args.title)} — ${esc(args.clientName)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.55 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    color: #1a1a1a; max-width: 52rem; margin: 2rem auto; padding: 0 1.5rem; }
  header { border-bottom: 2px solid #1a1a1a; padding-bottom: 1rem; margin-bottom: 1.5rem; }
  .kicker { text-transform: uppercase; letter-spacing: .08em; font-size: 11px; color: #666; }
  h1 { margin: .25rem 0 0; font-size: 24px; }
  h2 { font-size: 16px; margin: 1.75rem 0 .5rem; }
  table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; }
  th, td { text-align: left; padding: .35rem .6rem; border-bottom: 1px solid #e5e5e5; }
  th { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #666; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: #666; }
  footer { margin-top: 2rem; border-top: 1px solid #e5e5e5; padding-top: .75rem;
    font-size: 12px; color: #666; }
  @media print { body { margin: 0; max-width: none; } }
</style></head><body>
<header>
  <p class="kicker">AI Visibility Report</p>
  <h1>${esc(args.clientName)}</h1>
  <p class="muted">${esc(args.title)} · ${esc(args.periodStart)} → ${esc(args.periodEnd)}
    · published ${esc(args.publishedAt.slice(0, 10))}</p>
</header>
${narrative}
<section>
  <h2>Where you stand</h2>
  <table><thead><tr><th>Measure</th><th class="num">Value</th><th></th></tr></thead>
  <tbody>${scoreRows}</tbody></table>
</section>
${
  deltaRows
    ? `<section><h2>Change vs previous period</h2>
  ${body.comparable ? "" : `<p class="muted">${esc(body.comparabilityNote)}</p>`}
  <table><thead><tr><th>Measure</th><th class="num">Before</th><th class="num">Now</th>
  <th class="num">Change</th><th>Assessment</th></tr></thead>
  <tbody>${deltaRows}</tbody></table></section>`
    : ""
}
${
  ownershipRows
    ? `<section><h2>Question categories</h2>
  <table><thead><tr><th>Category</th><th>Standing</th><th class="num">Evidence</th>
  <th>Leading competitor</th></tr></thead><tbody>${ownershipRows}</tbody></table></section>`
    : ""
}
${programSection(body)}
<footer>
  Methodology ${esc(body.scoringVersion)}. Every value above is an observed
  measurement over repeated AI-assistant runs and carries its sample size;
  assessments follow the documented change-detection rules. This report was
  generated from an immutable snapshot and cannot drift from its evidence.
</footer>
</body></html>`;
}
