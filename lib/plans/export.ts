/**
 * Client-facing plan export (spec 026 follow-up).
 *
 * Spec 026 deferred this deliberately. Building it surfaced the thing that
 * makes a client export different from a screenshot of the internal page:
 * **the internal plan contains material a client should not receive.**
 *
 * Stripped from the client version:
 *   - composition hashes, finding ids, composer version — our provenance, not
 *     their reading;
 *   - exclusion reasons written for an operator ("No verified brokerage on
 *     file. Confirm it first.") which read as either jargon or an accusation;
 *   - the internal "excluded" section entirely, replaced by an honest
 *     statement of what we could not yet assess and why, in their language.
 *
 * Kept, deliberately:
 *   - the baseline numbers, including the unflattering ones. A plan that hides
 *     the starting position cannot demonstrate progress later.
 *   - the measurement for every play, phrased as an observation rather than a
 *     promise. This platform does not guarantee rankings (docs/12), and an
 *     exported document is exactly where an implied guarantee would be quoted
 *     back at us.
 *   - a plain split of who does what, because a plan where the client cannot
 *     see their own obligations is a plan that does not get executed.
 */
import type { PlanSummary } from "@/lib/plans/service";
import { escapeHtml } from "@/lib/text/html";

export type PlanExportFormat = "markdown" | "html";

interface Baseline {
  organicMentionRate?: number | null;
  topCompetitor?: string | null;
  topCompetitorRate?: number | null;
  citedDomains?: { domain: string; citations: number }[];
  ownDomainCited?: boolean;
  composedAt?: string;
}

const PHASE_LABELS: Record<string, { title: string; blurb: string }> = {
  foundation: {
    title: "Days 0–30 — Get found correctly",
    blurb: "Make sure AI assistants know who you are. Nothing else works until they do.",
  },
  authority: {
    title: "Days 31–60 — Build proof",
    blurb: "Put evidence where AI assistants already look.",
  },
  compounding: {
    title: "Days 61–90 — Compound and check",
    blurb: "Work that pays off once the first two phases have landed.",
  },
};

const OWNER_LABELS: Record<string, string> = {
  operator: "We do this",
  client: "You do this",
  shared: "We do this together",
};

function pct(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? "not measured" : `${Math.round(rate * 100)}%`;
}

/**
 * The client-safe Markdown document. Markdown because it pastes cleanly into
 * email, Docs and Notion — the three places a prospect will actually read it —
 * without carrying our stylesheet or implying a polish we did not commit to.
 */
export function renderPlanMarkdown(plan: PlanSummary, clientName: string): string {
  const baseline = plan.baseline as Baseline;
  const planned = plan.items.filter((i) => i.status !== "excluded");
  const notAssessed = plan.items.filter((i) => i.status === "excluded");
  const totalHours = planned.reduce((sum, i) => sum + i.effortHours, 0);
  const clientItems = planned.filter((i) => i.owner === "client" || i.owner === "shared");

  const lines: string[] = [];

  lines.push(`# ${clientName} — 90-day AI visibility plan`);
  lines.push("");
  lines.push(
    `Prepared ${baseline.composedAt ?? "recently"} · ${planned.length} actions · about ${totalHours} hours of work`
  );
  lines.push("");

  // ------------------------------------------------------------- where we are
  lines.push("## Where you stand today");
  lines.push("");
  lines.push(
    "These numbers come from asking AI assistants the questions your buyers actually ask, and recording what they answered."
  );
  lines.push("");
  lines.push(
    `- **You are mentioned in ${pct(baseline.organicMentionRate)} of relevant answers.**`
  );
  if (baseline.topCompetitor) {
    lines.push(
      `- ${baseline.topCompetitor} is mentioned in ${pct(baseline.topCompetitorRate)} of the same answers.`
    );
  }
  lines.push(
    `- Your own website was ${baseline.ownDomainCited ? "cited" : "**never cited**"} as a source in those answers.`
  );
  if (baseline.citedDomains?.length) {
    const top = baseline.citedDomains
      .slice(0, 3)
      .map((d) => `${d.domain} (${d.citations} times)`)
      .join(", ");
    lines.push(`- The sources AI drew on most: ${top}.`);
  }
  lines.push("");

  // ---------------------------------------------------------------- the plan
  for (const phase of ["foundation", "authority", "compounding"]) {
    const items = planned.filter((i) => i.phase === phase);
    if (items.length === 0) continue;
    const label = PHASE_LABELS[phase]!;
    const hours = items.reduce((sum, i) => sum + i.effortHours, 0);

    lines.push(`## ${label.title}`);
    lines.push("");
    lines.push(`${label.blurb} (about ${hours} hours)`);
    lines.push("");

    for (const item of items) {
      lines.push(`### ${item.position}. ${item.title}`);
      lines.push("");
      lines.push(`*${OWNER_LABELS[item.owner] ?? item.owner} · about ${item.effortHours} hours*`);
      lines.push("");
      lines.push(item.rationale);
      lines.push("");
      for (const step of item.steps) lines.push(`- ${step}`);
      if (item.steps.length > 0) lines.push("");
      lines.push(`**How we check it worked:** ${item.measurement}`);
      lines.push("");
    }
  }

  // ------------------------------------------------------ what we need of you
  if (clientItems.length > 0) {
    lines.push("## What we need from you");
    lines.push("");
    lines.push(
      "Everything not listed here, we handle. These need your side — either because only you can do them, or because we do them together."
    );
    lines.push("");
    for (const item of clientItems) {
      // Marked, because "together" and "yours alone" are different asks and a
      // client who cannot tell them apart will assume the smaller one.
      const share = item.owner === "shared" ? " *(together)*" : "";
      lines.push(`- **${item.title}**${share} (${item.effortHours}h) — ${item.rationale}`);
    }
    lines.push("");
  }

  // --------------------------------------------------- what we could not tell
  if (notAssessed.length > 0) {
    lines.push("## What we could not assess yet");
    lines.push("");
    lines.push(
      "We would rather tell you what we do not know than quietly leave it out. These need information we do not have yet:"
    );
    lines.push("");
    for (const item of notAssessed) {
      lines.push(`- **${item.title}** — we need more information before advising on this.`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "Every action above comes from a specific measurement, not from general best practice. We re-run the identical questions at day 90 and compare against the numbers at the top of this document."
  );
  lines.push("");
  lines.push(
    "We do not guarantee rankings or mentions. AI assistants change how they retrieve and answer, and anyone promising a specific position is guessing."
  );

  return lines.join("\n");
}

/** Minimal self-contained HTML, for a client who wants to print or PDF it. */
export function renderPlanHtml(plan: PlanSummary, clientName: string): string {
  const markdown = renderPlanMarkdown(plan, clientName);
  const body = markdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("### ")) return `<h3>${escapeHtml(line.slice(4))}</h3>`;
      if (line.startsWith("## ")) return `<h2>${escapeHtml(line.slice(3))}</h2>`;
      if (line.startsWith("# ")) return `<h1>${escapeHtml(line.slice(2))}</h1>`;
      if (line.startsWith("- ")) return `<li>${inline(line.slice(2))}</li>`;
      if (line === "---") return "<hr>";
      if (line.trim() === "") return "";
      return `<p>${inline(line)}</p>`;
    })
    .join("\n")
    // Wrap consecutive list items rather than emitting loose <li>.
    .replace(/(<li>[\s\S]*?<\/li>)(?!\n<li>)/g, (match) => `<ul>${match}</ul>`);

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(clientName)} — 90-day AI visibility plan</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         max-width: 46rem; margin: 3rem auto; padding: 0 1.5rem; color: #1a1a1a; }
  h1 { font-size: 1.9rem; margin-bottom: .25rem; }
  h2 { font-size: 1.3rem; margin-top: 2.5rem; border-bottom: 1px solid #e5e5e5; padding-bottom: .3rem; }
  h3 { font-size: 1.05rem; margin-top: 1.75rem; }
  ul { padding-left: 1.25rem; }
  li { margin: .3rem 0; }
  hr { border: 0; border-top: 1px solid #e5e5e5; margin: 2.5rem 0; }
  em { color: #666; }
  @media print { body { margin: 0; max-width: none; } h2 { page-break-after: avoid; } }
</style></head>
<body>
${body}
</body></html>`;
}


/** Bold and italic only — the export carries no links or images by design. */
function inline(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}
