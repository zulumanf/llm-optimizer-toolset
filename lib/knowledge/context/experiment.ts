/**
 * Context-strategy token comparison (spec 020 Phase 6).
 *
 * Compares four ways of giving an agent the same task:
 *
 *   A. raw documents  — every extracted source, concatenated
 *   B. full wiki      — every compiled page for the client
 *   C. hot files      — only the compiled hot files
 *   D. task packet    — the template-built context packet
 *
 * **What this measures and what it does not.** It measures *input tokens*,
 * counted locally and deterministically, at zero cost. That number is real and
 * reported. It does NOT measure accuracy, unsupported-claim rate, human
 * correction time or verifier rejection rate — those require running a real
 * provider across all four modes, which spends money and is therefore the
 * opt-in live harness deferred to spec 025.
 *
 * So: report the token deltas this produces. Report quality as **not measured**.
 * A token reduction with no quality comparison is a claim about cost, not a
 * claim about whether the system still works.
 */
import { sql } from "@/db/client";
import { estimateTokens } from "@/lib/knowledge/context/tokens";
import { buildPacket, renderContextPacket, type ContextPacketRequest } from "@/lib/knowledge/context/builder";
import { readActivePage } from "@/lib/knowledge/compiler/compile";
import { hotFileTemplates, CLIENT_PAGE_TEMPLATES } from "@/lib/knowledge/compiler/templates";

export type ContextMode = "raw_documents" | "full_wiki" | "hot_files" | "task_packet";

export interface ModeMeasurement {
  mode: ContextMode;
  /** Deterministic local estimate. Never a provider-reported figure. */
  inputTokens: number;
  characters: number;
  /** How many discrete pieces of context the mode assembled. */
  units: number;
  /** Null when the mode could not be assembled (nothing compiled yet, say). */
  unavailableReason: string | null;
}

export interface ContextExperimentResult {
  projectId: string;
  templateKey: string;
  taskObjective: string;
  measuredAt: string;
  modes: ModeMeasurement[];
  /** Reductions relative to raw documents. Null when raw was unavailable. */
  reductionVsRaw: Record<ContextMode, number | null>;
  /** Stated on every result so no reader mistakes this for a quality claim. */
  qualityMeasured: false;
  note: string;
}

const QUALITY_NOTE =
  "Input tokens only, counted locally. Accuracy, unsupported-claim rate, human correction time " +
  "and verifier rejection rate were NOT measured — that requires a live provider run (spec 025).";

/**
 * Run the comparison for one client and task. Makes no provider calls, so it is
 * safe in CI and safe to run on every seeded client.
 */
export async function compareContextModes(
  request: ContextPacketRequest
): Promise<ContextExperimentResult> {
  const modes: ModeMeasurement[] = [
    await measureRawDocuments(request.projectId),
    await measureFullWiki(request.projectId),
    await measureHotFiles(request.projectId),
    await measureTaskPacket(request),
  ];

  const raw = modes.find((m) => m.mode === "raw_documents");
  const baseline = raw && raw.unavailableReason === null ? raw.inputTokens : null;

  const reductionVsRaw = Object.fromEntries(
    modes.map((m) => [
      m.mode,
      baseline === null || baseline === 0 || m.unavailableReason !== null
        ? null
        : Number((1 - m.inputTokens / baseline).toFixed(4)),
    ])
  ) as Record<ContextMode, number | null>;

  return {
    projectId: request.projectId,
    templateKey: request.templateKey,
    taskObjective: request.taskObjective,
    measuredAt: new Date().toISOString(),
    modes,
    reductionVsRaw,
    qualityMeasured: false,
    note: QUALITY_NOTE,
  };
}

/** Mode A: what an agent would receive with no compilation layer at all. */
async function measureRawDocuments(projectId: string): Promise<ModeMeasurement> {
  const rows = await sql`
    select d.text
    from extracted_documents d
    join source_artifacts a on a.id = d.source_artifact_id
    where a.project_id = ${projectId} and a.superseded_at is null
      and d.status = 'extracted'
    order by a.retrieved_at desc
  `;
  if (rows.length === 0) {
    return unavailable("raw_documents", "No extracted sources are held for this client.");
  }
  const text = rows.map((row) => row.text as string).join("\n\n");
  return {
    mode: "raw_documents",
    inputTokens: estimateTokens(text),
    characters: text.length,
    units: rows.length,
    unavailableReason: null,
  };
}

/** Mode B: every compiled page, concatenated. */
async function measureFullWiki(projectId: string): Promise<ModeMeasurement> {
  const bodies: string[] = [];
  for (const template of CLIENT_PAGE_TEMPLATES) {
    const page = await readActivePage({ projectId, slug: template.slug });
    if (page) bodies.push(page.body);
  }
  if (bodies.length === 0) {
    return unavailable("full_wiki", "No pages have been compiled for this client.");
  }
  const text = bodies.join("\n\n");
  return {
    mode: "full_wiki",
    inputTokens: estimateTokens(text),
    characters: text.length,
    units: bodies.length,
    unavailableReason: null,
  };
}

/** Mode C: the hot files only. */
async function measureHotFiles(projectId: string): Promise<ModeMeasurement> {
  const bodies: string[] = [];
  for (const template of hotFileTemplates()) {
    const page = await readActivePage({ projectId, slug: template.slug });
    if (page) bodies.push(page.body);
  }
  if (bodies.length === 0) {
    return unavailable("hot_files", "No hot files have been compiled for this client.");
  }
  const text = bodies.join("\n\n");
  return {
    mode: "hot_files",
    inputTokens: estimateTokens(text),
    characters: text.length,
    units: bodies.length,
    unavailableReason: null,
  };
}

/** Mode D: the packet an agent actually receives. */
async function measureTaskPacket(request: ContextPacketRequest): Promise<ModeMeasurement> {
  try {
    const packet = await buildPacket(request);
    const text = renderContextPacket(packet);
    return {
      mode: "task_packet",
      inputTokens: estimateTokens(text),
      characters: text.length,
      units: packet.items.filter((i) => i.included).length,
      unavailableReason: null,
    };
  } catch (err) {
    return unavailable("task_packet", (err as Error).message);
  }
}

function unavailable(mode: ContextMode, reason: string): ModeMeasurement {
  return {
    mode,
    inputTokens: 0,
    characters: 0,
    units: 0,
    unavailableReason: reason,
  };
}

/** Render the comparison as the table that goes into a deliverable. */
export function formatComparison(result: ContextExperimentResult): string {
  const lines = [
    `Context strategy comparison — ${result.templateKey} — ${result.measuredAt.slice(0, 10)}`,
    "",
    "| Mode | Input tokens | Units | Reduction vs raw |",
    "|---|---:|---:|---:|",
  ];
  for (const mode of result.modes) {
    const reduction = result.reductionVsRaw[mode.mode];
    lines.push(
      `| ${mode.mode.replace(/_/g, " ")} | ${
        mode.unavailableReason ? "n/a" : mode.inputTokens.toLocaleString()
      } | ${mode.unavailableReason ? "n/a" : mode.units} | ${
        reduction === null ? "n/a" : `${(reduction * 100).toFixed(1)}%`
      } |`
    );
  }
  const unavailable = result.modes.filter((m) => m.unavailableReason);
  if (unavailable.length > 0) {
    lines.push("", "Unavailable modes:");
    for (const mode of unavailable) {
      lines.push(`- ${mode.mode.replace(/_/g, " ")}: ${mode.unavailableReason}`);
    }
  }
  lines.push("", result.note);
  return lines.join("\n");
}
