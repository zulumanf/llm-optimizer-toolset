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

const SECTION_LABELS: Record<string, string> = {
  summary: "Executive summary",
  competitors: "Competitive picture",
  notable_responses: "Notable AI answers",
  suggested_actions: "Recommended next steps",
};

const METRIC_LABELS: Record<string, string> = {
  mention_rate: "Mentioned in answers",
  recommendation_rate: "Actively recommended",
  first_position_rate: "Recommended first",
  top_three_rate: "In the top three",
  share_of_voice: "Share of AI voice",
  citation_score: "Own sources cited",
  authority_score: "Authority score",
  position_score: "List position",
  sentiment_index: "Sentiment",
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
        <td class="num">${fmt(d.metric, Number(d.previous))}</td>
        <td class="num">${fmt(d.metric, Number(d.current))}</td>
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
<footer>
  Methodology ${esc(body.scoringVersion)}. Every value above is an observed
  measurement over repeated AI-assistant runs and carries its sample size;
  assessments follow the documented change-detection rules. This report was
  generated from an immutable snapshot and cannot drift from its evidence.
</footer>
</body></html>`;
}
