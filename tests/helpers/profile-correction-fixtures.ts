/**
 * Spec 147 integration fixtures: a client with confirmed profile URLs and
 * approved facts, a stubbed network (profile pages + the local Ollama
 * endpoint for extraction and comparison), and drivers that take a profile
 * check through the real queue, event bus and engine.
 */
import { expect, vi } from "vitest";
import type { Sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { normalizeCategory, normalizePredicate } from "@/lib/knowledge/extraction/claims";

export const OPERATOR: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

export const WRONG_BROKER = "Perez Realty Group is a Compass team in Jersey City.";
export const RIGHT_BROKER_TEXT = "Perez Realty Group is affiliated with Douglas Elliman.";
export const RIGHT_SALES_TEXT = "Perez Realty Group closed 42 homes in 2025.";
export const WRONG_SALES = "Perez Realty Group closed 40 homes in 2025.";
export const MODEL_PROSE = "Model explanation: the brokerage differs.";

function draft(wording: string, normalized: string, category: string) {
  return {
    subject: "Perez Realty Group",
    predicate: "states",
    object: "",
    originalWording: wording,
    normalizedWording: normalized,
    category,
    asOf: null,
    value: null,
    confidence: 0.9,
    locator: "",
  };
}

/** What the stub extractor proposes for each sentence found on a page. */
const EXTRACTABLE: Record<string, ReturnType<typeof draft>> = {
  [WRONG_BROKER]: draft(WRONG_BROKER, "Perez Realty Group is affiliated with Compass.", "affiliation"),
  [WRONG_SALES]: draft(WRONG_SALES, WRONG_SALES, "transaction"),
  // Restatements of the approved facts: extraction matches them to the
  // approved claims (spec 145E), which is how a recheck sees a fact affirmed.
  [RIGHT_BROKER_TEXT]: draft(RIGHT_BROKER_TEXT, RIGHT_BROKER_TEXT, "affiliation"),
  [RIGHT_SALES_TEXT]: draft(RIGHT_SALES_TEXT, RIGHT_SALES_TEXT, "transaction"),
};

export function profilePage(lines: string[], marker = ""): string {
  return `<html><head><title>Perez Realty Group</title></head><body>${lines
    .map((l) => `<p>${l}</p>`)
    .join("")}${marker ? `<!-- ${marker} -->` : ""}</body></html>`;
}

export interface Network {
  pages: Map<string, string>;
  calls: string[];
  /** "invalid" makes the comparison answer fail Spec 146's guard. */
  compareMode: "normal" | "invalid";
  modelCalls: number;
}

/** Profile pages by URL; Ollama answers extraction and comparison. */
export function stubNetwork(): Network {
  const net: Network = { pages: new Map(), calls: [], compareMode: "normal", modelCalls: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      net.calls.push(url);
      if (url.endsWith("/api/chat")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: string;
          messages?: { role: string; content: string }[];
        };
        const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
        net.modelCalls += 1;
        const content =
          body.model === "qwen3:30b"
            ? net.compareMode === "invalid"
              ? JSON.stringify({
                  contradictions: [
                    { observedClaimId: "fabricated", approvedClaimId: "fabricated", statementA: "x", statementB: "y", severity: "low", explanation: "" },
                  ],
                  confidence: 0.5,
                })
              : compareAnswer(user)
            : extractAnswer(user);
        return new Response(
          JSON.stringify({ message: { role: "assistant", content }, prompt_eval_count: 10, eval_count: 5 }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      const page = net.pages.get(url);
      if (page !== undefined) {
        return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("not found", { status: 404 });
    })
  );
  return net;
}

function extractAnswer(prompt: string): string {
  const claims = Object.entries(EXTRACTABLE)
    .filter(([sentence]) => prompt.includes(sentence))
    .map(([, claim]) => claim);
  return JSON.stringify({ claims });
}

function compareAnswer(user: string): string {
  const payload = JSON.parse(user.slice(user.indexOf("{"))) as {
    context: {
      observedClaims: { claimId: string; normalizedWording: string }[];
      approvedFacts: { claims: { id: string; key: string; text: string }[] };
    };
  };
  const approved = (key: string) => payload.context.approvedFacts.claims.find((c) => c.key === key);
  const contradictions = payload.context.observedClaims.flatMap((o) => {
    const target = o.normalizedWording.includes("Compass")
      ? { fact: approved("brokerage"), severity: "critical" }
      : o.normalizedWording.includes("40 homes")
        ? { fact: approved("sales.2025.count"), severity: "high" }
        : null;
    return target?.fact
      ? [
          {
            observedClaimId: o.claimId,
            approvedClaimId: target.fact.id,
            statementA: o.normalizedWording,
            statementB: target.fact.text,
            severity: target.severity,
            explanation: MODEL_PROSE,
          },
        ]
      : [];
  });
  return JSON.stringify({ contradictions, confidence: 0.93 });
}

export interface ClientFixture {
  projectId: string;
  engagementId: string;
  evidence: string[];
}

/** A live client with a subject identity, approved facts and confirmed URLs. */
export async function seedClient(
  sql: Sql,
  name: string,
  profileUrls: string[],
  opts: { contactEmail?: string; contactName?: string } = {}
): Promise<ClientFixture> {
  const [market] = await sql`insert into markets (name, kind) values (${`${name} market`}, 'city') returning id`;
  const [company] = await sql`
    insert into companies (name, aliases, domain, is_self, market_id)
    values ('Perez Realty Group', ${[]}, null, true, ${market!.id}) returning id
  `;
  const [project] = await sql`
    insert into projects (name, subject_company_id) values (${name}, ${company!.id}) returning id
  `;
  const projectId = project!.id as string;
  const [engagement] = await sql`
    insert into client_engagements (project_id, market_id, starts_on, ends_on, renewal_review_on,
      monthly_fee_usd, total_value_usd, stage, primary_contact_name)
    values (${projectId}, ${market!.id}, '2026-10-01', '2026-12-31', '2026-12-01', 1000, 3000, 'active',
      ${opts.contactName ?? ""})
    returning id
  `;
  const engagementId = engagement!.id as string;
  for (const [i, url] of profileUrls.entries()) {
    await sql`
      insert into engagement_context_items (engagement_id, project_id, kind, label, provenance, source_ref, created_at)
      values (${engagementId}, ${projectId}, 'asset', ${url}, 'client_confirmed', ${url},
        ${new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString()})
    `;
  }
  if (opts.contactEmail) {
    await sql`
      insert into engagement_context_items (engagement_id, project_id, kind, label, provenance, value)
      values (${engagementId}, ${projectId}, 'identity', ${`${name} (team)`}, 'client_confirmed',
        ${sql.json({ contactEmail: opts.contactEmail })})
    `;
  }
  const evidence: string[] = [];
  for (const note of ["Brokerage license record", "Agent roster"]) {
    const [row] = await sql`
      insert into evidence (kind, ref_id, note) values ('source', gen_random_uuid(), ${note}) returning id
    `;
    evidence.push(row!.id as string);
  }
  // The approved facts carry the claim identity extraction uses (spec 145E),
  // so a page that restates one is matched to it rather than proposed again.
  const predicate = normalizePredicate("states");
  await sql`
    insert into claims (project_id, key, canonical_text, status, evidence_ids, subject_entity, normalized_predicate, category)
    values (${projectId}, 'brokerage', ${RIGHT_BROKER_TEXT}, 'approved', ${evidence}::uuid[],
        'Perez Realty Group', ${predicate}, ${normalizeCategory("affiliation")}),
      (${projectId}, 'sales.2025.count', ${RIGHT_SALES_TEXT}, 'approved', ${[evidence[0]!]}::uuid[],
        'Perez Realty Group', ${predicate}, ${normalizeCategory("transaction")})
  `;
  return { projectId, engagementId, evidence };
}

export const TERMINAL_OR_PARKED = [
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
  "safely_stopped",
  "timed_out",
  "partially_completed",
];

export interface Drivers {
  sql: Sql;
  start: typeof import("@/lib/profile-corrections/start");
  dispatch: typeof import("@/lib/profile-corrections/dispatch");
  autoDispatch: typeof import("@/lib/automation/dispatch");
  engine: typeof import("@/lib/workflow/engine");
  approvals: typeof import("@/app/workflows/actions");
}

export async function drive(d: Drivers, runId: string): Promise<string> {
  let state = "";
  for (let i = 0; i < 25; i += 1) {
    state = await d.engine.advanceWorkflow(runId);
    if (TERMINAL_OR_PARKED.includes(state)) break;
  }
  return state;
}

/** Queue → release → deliver → run, up to the approval gate (or an end). */
export async function checkProfile(
  d: Drivers,
  projectId: string,
  now: Date
): Promise<{ runId: string; state: string }> {
  const queued = await d.start.startProfileChecks(OPERATOR, { projectId, origin: "operator" }, now);
  expect(queued.ok && queued.data.queued.length).toBeGreaterThan(0);
  const report = await d.dispatch.dispatchProfileChecks();
  expect(report.released).toHaveLength(1);
  const [row] = await d.sql`select * from profile_check_requests where id = ${report.released[0]!}`;
  await d.autoDispatch.deliverOneEvent(row!.eventId as string);
  const [run] = await d.sql`select id from workflow_runs where idempotency_key = ${row!.runIdempotencyKey}`;
  const runId = run!.id as string;
  return { runId, state: await drive(d, runId) };
}

/** A correction approved by a human and routed by its run. */
export async function approveCorrection(d: Drivers, runId: string): Promise<string> {
  const [approval] = await d.sql`select id from workflow_approvals where workflow_run_id = ${runId}`;
  const decided = await d.approvals.decideApprovalAction({
    approvalId: approval!.id,
    decision: "approved",
    rationale: "Checked against the license record.",
  });
  expect(decided.ok).toBe(true);
  return drive(d, runId);
}
