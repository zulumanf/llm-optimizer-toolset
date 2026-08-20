/**
 * The assistant's operator tool belt (spec 096). Thin wrappers over
 * existing services — no new business logic; every gate, ledger, and audit
 * row is the service's own. Three tiers, enforced structurally:
 *
 * - read:    lookups (plus the MCP observer tools, which stay as they are).
 * - direct:  staging/research actions that are suggestions by construction
 *            (drafts, candidates, staged proposals). Execute immediately.
 * - confirm: spends money or crosses a consequence line (send, publish,
 *            approve, stage change, live run). Invoking one mints a pending
 *            action for a human button — it never executes from the model.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import * as svc from "@/lib/prospects/service";
import { publishAudit } from "@/lib/prospects/audits";
import { enrichProspect, approveEnrichmentProposal } from "@/lib/prospects/enrichment";
import { runProspectDiscovery } from "@/lib/prospects/discovery";
import { draftMarketPack, installMarketPackDraft } from "@/lib/markets/research";
import { bootstrapMarketBenchmark } from "@/lib/markets/bootstrap";
import {
  actionQueues,
  engagementNow,
  eventFunnel,
  machineHealth,
} from "@/lib/prospects/dashboard";
import { invokeTool } from "@/lib/mcp/tools";
import { ClassifiedError } from "@/lib/errors";
import type { ActionResult } from "@/lib/actions/result";

export type AssistantToolTier = "read" | "direct" | "confirm";

export interface AssistantToolDef {
  name: string;
  description: string;
  tier: AssistantToolTier;
  schema: z.ZodTypeAny;
  /** One line shown on the confirm button, built from validated input. */
  summarize?: (input: Record<string, unknown>) => string;
  run: (user: CurrentUser, input: Record<string, unknown>) => Promise<unknown>;
}

const unwrapResult = <T>(r: ActionResult<T>): T => {
  if (!r.ok) throw new ClassifiedError(r.error.kind, r.error.message);
  return r.data;
};

const uuid = z.string().uuid();

export const ASSISTANT_TOOLS: AssistantToolDef[] = [
  // ------------------------------------------------------------- read
  {
    name: "pipeline_dashboard",
    description:
      "The prospecting pipeline at a glance: engagement since yesterday (opens are an upper bound; audit views are human-like external only), the event-derived funnel, the action queues, and machine health (send cap, gmail status).",
    tier: "read",
    schema: z.object({}),
    run: async () => {
      const [engagement, funnel, queues, health] = await Promise.all([
        engagementNow(),
        eventFunnel(),
        actionQueues(),
        machineHealth(),
      ]);
      return { engagement, funnel, queues, health };
    },
  },
  {
    name: "list_prospects",
    description:
      "Active prospects with stage, market, contact-email presence, sends, and engagement counts. Optional name filter (case-insensitive substring).",
    tier: "read",
    schema: z.object({ name: z.string().trim().max(120).optional() }),
    run: async (_user, input) => {
      const name = typeof input.name === "string" ? `%${input.name}%` : "%";
      const rows = await sql`
        select p.id, p.business_name, p.stage, m.name as market,
          exists (select 1 from prospect_contacts c where c.prospect_id = p.id
            and c.archived_at is null and not c.do_not_contact and c.email is not null) as has_email,
          (select count(*)::int from prospect_outreach_sends s
            where s.prospect_id = p.id and s.allowed) as sends,
          (select count(*)::int from outreach_email_opens o
            join prospect_outreach_sends s on s.id = o.send_id
            where s.prospect_id = p.id) as opens
        from prospects p
        join market_launches l on l.id = p.launch_id
        join markets m on m.id = l.market_id
        where p.archived_at is null and p.business_name ilike ${name}
        order by p.business_name
        limit 60
      `;
      return rows;
    },
  },
  {
    name: "get_prospect",
    description:
      "One prospect's working state: stage, contacts, findings (status), drafts (status, schedule), sends with engagement, published audit link.",
    tier: "read",
    schema: z.object({ prospect_id: uuid }),
    run: async (_user, input) => {
      const id = input.prospect_id as string;
      const [prospect] = await sql`
        select p.id, p.business_name, p.stage, p.email, m.name as market
        from prospects p
        join market_launches l on l.id = p.launch_id
        join markets m on m.id = l.market_id
        where p.id = ${id}
      `;
      if (!prospect) throw new ClassifiedError("not_found", "Prospect not found.");
      const contacts = await sql`
        select id, name, email, is_primary, do_not_contact from prospect_contacts
        where prospect_id = ${id} and archived_at is null
      `;
      const findings = await sql`
        select id, kind, title, status, is_primary from prospect_findings
        where prospect_id = ${id} and status in ('candidate','approved')
        order by created_at desc limit 10
      `;
      const drafts = await sql`
        select id, status, subject, sent_recorded_at, scheduled_send_at, last_send_error
        from outreach_drafts where prospect_id = ${id}
        order by created_at desc limit 10
      `;
      const sends = await sql`
        select s.id, s.channel, s.recipient_email, s.sent_at, s.allowed,
          (select count(*)::int from outreach_email_opens o where o.send_id = s.id) as opens
        from prospect_outreach_sends s where s.prospect_id = ${id}
        order by s.sent_at desc limit 10
      `;
      const [audit] = await sql`
        select a.status, a.published_at, a.expires_at, l.slug, l.key
        from prospect_audits a
        left join prospect_audit_links l on l.prospect_id = a.prospect_id
        where a.prospect_id = ${id} and a.status = 'published'
        order by a.published_at desc limit 1
      `;
      return { prospect, contacts, findings, drafts, sends, audit: audit ?? null };
    },
  },

  // ----------------------------------------------------------- direct
  {
    name: "research_market",
    description:
      "Start researching a city: Perplexity-composes a market pack draft (market definition, buyer/seller prompt pack, notable agents). Returns the staged draft for review — install_market_pack makes it real. THE entry point for 'research the agents in X city'.",
    tier: "direct",
    schema: z.object({ city_name: z.string().trim().min(2), state: z.string().trim().min(2) }),
    run: async (user, input) =>
      unwrapResult(
        await draftMarketPack(user, {
          cityName: input.city_name,
          state: input.state,
        })
      ),
  },
  {
    name: "install_market_pack",
    description:
      "Install a reviewed market pack draft: creates the market, launch, and frozen prompt pack. Internal artifacts only — benchmarks and outreach still have their own gates.",
    tier: "direct",
    schema: z.object({ draft_id: uuid, price_segment: z.string().trim().max(120).optional() }),
    run: async (user, input) =>
      unwrapResult(
        await installMarketPackDraft(user, {
          draftId: input.draft_id,
          ...(input.price_segment ? { priceSegment: input.price_segment } : {}),
        })
      ),
  },
  {
    name: "bootstrap_market_benchmark",
    description:
      "For an installed market launch: create (or find) its benchmark project, generate the prompt set from the installed pack, and freeze it — returns project_id, prompt_set_version_id, prompt count, and a suggestedProviders config copied from the most recent completed run. THE step between install_market_pack and estimate_benchmark_run; tell the operator to review the prompts before confirming a run.",
    tier: "direct",
    schema: z.object({ launch_id: uuid, cap: z.number().int().min(4).max(200).optional() }),
    run: async (user, input) =>
      unwrapResult(
        await bootstrapMarketBenchmark(user, {
          launchId: input.launch_id,
          ...(typeof input.cap === "number" ? { cap: input.cap } : {}),
        })
      ),
  },
  {
    name: "run_discovery",
    description:
      "Research a launch's market for agent/team prospects via an external source (Perplexity by default — no benchmark needed first). Returns staged candidates for operator review; use segment to focus (e.g. 'top-producing teams', 'RealTrends-ranked teams') and limit for a target count.",
    tier: "direct",
    schema: z.object({
      launch_id: uuid,
      provider: z.enum(["perplexity", "mock"]).default("perplexity"),
      segment: z.string().trim().max(120).optional(),
      limit: z.number().int().positive().max(50).optional(),
    }),
    run: async (user, input) =>
      unwrapResult(
        await runProspectDiscovery(user, {
          launchId: input.launch_id,
          provider: input.provider ?? "perplexity",
          ...(input.segment ? { segment: input.segment } : {}),
          ...(typeof input.limit === "number" ? { limit: input.limit } : {}),
        })
      ),
  },
  {
    name: "enrich_prospect",
    description:
      "Perplexity research on one prospect (contact email, production numbers, recent developments) — staged proposals, nothing written until approved.",
    tier: "direct",
    schema: z.object({ prospect_id: uuid, force: z.boolean().optional() }),
    run: async (user, input) =>
      unwrapResult(
        await enrichProspect(user, {
          prospectId: input.prospect_id,
          force: input.force === true,
        })
      ),
  },
  {
    name: "generate_findings",
    description:
      "Regenerate finding candidates for a prospect's benchmark (deterministic, evidence-linked). Candidates await human approval.",
    tier: "direct",
    schema: z.object({ benchmark_id: uuid }),
    run: async (user, input) =>
      unwrapResult(await svc.generateFindings(user, { benchmarkId: input.benchmark_id })),
  },
  {
    name: "create_outreach_draft",
    description:
      "Generate the system outreach draft (audit link + compliant footer embedded) for a prospect. A draft cannot send without approval.",
    tier: "direct",
    schema: z.object({ prospect_id: uuid, contact_id: uuid.optional() }),
    run: async (user, input) =>
      unwrapResult(
        await svc.createOutreachDraft(user, {
          prospectId: input.prospect_id,
          channel: "email",
          ...(input.contact_id ? { contactId: input.contact_id } : {}),
        })
      ),
  },
  {
    name: "add_contact",
    description:
      "Record a contact (name/email) on a prospect. Provide the source in notes — provenance is recorded as ai_inferred unless operator-verified elsewhere.",
    tier: "direct",
    schema: z.object({
      prospect_id: uuid,
      name: z.string().trim().min(1).max(160),
      email: z.string().email(),
      notes: z.string().trim().max(500).optional(),
    }),
    run: async (user, input) =>
      unwrapResult(
        await svc.addContact(user, {
          prospectId: input.prospect_id,
          name: input.name,
          email: input.email,
          provenance: "ai_inferred",
          ...(input.notes ? { notes: input.notes } : {}),
        })
      ),
  },
  {
    name: "estimate_benchmark_run",
    description:
      "Cost estimate for running a frozen prompt-set version against providers — a dry run; creates nothing, spends nothing.",
    tier: "direct",
    schema: z.object({
      project_id: uuid,
      prompt_set_version_id: uuid,
      providers: z.array(
        z.object({ provider: z.string(), model: z.string(), repetitions: z.number().int().min(1).max(10) })
      ),
      budget_usd: z.number().positive(),
      label: z.string().trim().min(1).max(120),
    }),
    run: async (user, input) =>
      invokeTool(user, "run_prompt_set", { ...input, dry_run: true }),
  },

  // ---------------------------------------------------------- confirm
  {
    name: "start_benchmark_run",
    description:
      "Start a LIVE benchmark run (spends provider budget). Requires operator confirmation — run estimate_benchmark_run first and include the cost in your message.",
    tier: "confirm",
    schema: z.object({
      project_id: uuid,
      prompt_set_version_id: uuid,
      providers: z.array(
        z.object({ provider: z.string(), model: z.string(), repetitions: z.number().int().min(1).max(10) })
      ),
      budget_usd: z.number().positive(),
      label: z.string().trim().min(1).max(120),
    }),
    summarize: (i) =>
      `Start live benchmark run "${String(i.label)}" (budget $${String(i.budget_usd)})`,
    run: async (user, input) => invokeTool(user, "run_prompt_set", { ...input, dry_run: false }),
  },
  {
    name: "approve_finding",
    description:
      "Approve a finding candidate (optionally as primary). Confirmation required — approval is the human signature the audit builds on.",
    tier: "confirm",
    schema: z.object({ finding_id: uuid, make_primary: z.boolean().default(true) }),
    summarize: (i) => `Approve finding ${String(i.finding_id).slice(0, 8)}… as ${i.make_primary === false ? "non-primary" : "primary"}`,
    run: async (user, input) =>
      unwrapResult(
        await svc.reviewFinding(user, {
          findingId: input.finding_id,
          decision: "approved",
          makePrimary: input.make_primary !== false,
        })
      ),
  },
  {
    name: "publish_audit",
    description:
      "Publish (or republish) a prospect's audit page — a public URL. Confirmation required.",
    tier: "confirm",
    schema: z.object({ prospect_id: uuid, acknowledge_stale: z.boolean().default(false) }),
    summarize: (i) => `Publish the audit for prospect ${String(i.prospect_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(
        await publishAudit(user, {
          prospectId: input.prospect_id,
          ...(input.acknowledge_stale === true ? { acknowledgeStale: true } : {}),
        })
      ),
  },
  {
    name: "approve_draft",
    description:
      "Approve an outreach draft — freezes the exact text a send may transmit. Confirmation required.",
    tier: "confirm",
    schema: z.object({ draft_id: uuid }),
    summarize: (i) => `Approve outreach draft ${String(i.draft_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(await svc.approveOutreachDraft(user, { draftId: input.draft_id })),
  },
  {
    name: "send_draft",
    description:
      "Send an APPROVED draft via Gmail right now (full gate chain re-runs). Confirmation required — this emails a real person.",
    tier: "confirm",
    schema: z.object({ draft_id: uuid, business_purpose: z.string().trim().min(10).max(1000) }),
    summarize: (i) => `Send draft ${String(i.draft_id).slice(0, 8)}… via Gmail now`,
    run: async (user, input) =>
      unwrapResult(
        await svc.sendProspectDraft(user, {
          draftId: input.draft_id,
          channel: "gmail",
          businessPurpose: input.business_purpose,
        })
      ),
  },
  {
    name: "schedule_send",
    description:
      "Schedule an APPROVED draft's Gmail transmission (future time, ≤30 days). Confirmation required.",
    tier: "confirm",
    schema: z.object({
      draft_id: uuid,
      send_at: z.string().datetime(),
      business_purpose: z.string().trim().min(10).max(1000),
    }),
    summarize: (i) => `Schedule draft ${String(i.draft_id).slice(0, 8)}… to send ${String(i.send_at)}`,
    run: async (user, input) =>
      unwrapResult(
        await svc.scheduleDraftSend(user, {
          draftId: input.draft_id,
          sendAt: input.send_at,
          businessPurpose: input.business_purpose,
        })
      ),
  },
  {
    name: "approve_enrichment",
    description:
      "Approve a staged enrichment proposal (writes the contact/signal it proposes). Confirmation required.",
    tier: "confirm",
    schema: z.object({ proposal_id: uuid }),
    summarize: (i) => `Approve enrichment proposal ${String(i.proposal_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(await approveEnrichmentProposal(user, { proposalId: input.proposal_id })),
  },
  {
    name: "advance_stage",
    description:
      "Advance a prospect's recorded pipeline stage (e.g. contacted, replied, discovery_scheduled). Confirmation required — stages gate downstream behavior.",
    tier: "confirm",
    schema: z.object({ prospect_id: uuid, stage: z.string().min(1), reason: z.string().trim().max(300).optional() }),
    summarize: (i) => `Move prospect ${String(i.prospect_id).slice(0, 8)}… to stage "${String(i.stage)}"`,
    run: async (user, input) =>
      unwrapResult(
        await svc.transitionStage(user, {
          prospectId: input.prospect_id,
          toStage: input.stage,
          ...(input.reason ? { reason: input.reason } : {}),
        })
      ),
  },
];

export const CONFIRM_REQUIRED = new Set(
  ASSISTANT_TOOLS.filter((t) => t.tier === "confirm").map((t) => t.name)
);

export function getAssistantTool(name: string): AssistantToolDef | null {
  return ASSISTANT_TOOLS.find((t) => t.name === name) ?? null;
}

/** Validate and execute one assistant tool as the given user — the single
 * dispatch used by both the direct path and the confirm path. */
export async function runAssistantTool(
  user: CurrentUser,
  name: string,
  rawInput: Record<string, unknown>
): Promise<unknown> {
  const tool = getAssistantTool(name);
  if (!tool) throw new ClassifiedError("not_found", `Unknown assistant tool "${name}".`);
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    // Self-healing errors: state the expected shape so the model corrects
    // its input and retries in-loop instead of asking the operator.
    throw new ClassifiedError(
      "validation",
      `Invalid input for ${name} (${parsed.error.issues[0]?.message ?? "bad shape"}). Expected shape: ${describeSchema(tool.schema)} — fix the input and call the tool again.`
    );
  }
  return tool.run(user, parsed.data as Record<string, unknown>);
}

// ------------------------------------------------------- schema describer

/** Compact, model-readable shape for a zod schema — derived, never
 * hand-written, so the catalog cannot drift from validation (spec 096
 * follow-up: the model guessed input shapes and gave up on mismatch). */
export function describeSchema(schema: z.ZodTypeAny): string {
  const walk = (s: z.ZodTypeAny): string => {
    const def = (s as { _def: { typeName: string } })._def;
    switch (def.typeName) {
      case "ZodObject": {
        const shape = (s as z.AnyZodObject).shape as Record<string, z.ZodTypeAny>;
        const parts = Object.entries(shape).map(([key, value]) => {
          const optional =
            value.isOptional() || value._def.typeName === "ZodDefault" ? "?" : "";
          return `"${key}"${optional}: ${walk(value)}`;
        });
        return `{${parts.join(", ")}}`;
      }
      case "ZodOptional":
      case "ZodDefault":
      case "ZodNullable":
        return walk((def as unknown as { innerType: z.ZodTypeAny }).innerType);
      case "ZodArray":
        return `[${walk((def as unknown as { type: z.ZodTypeAny }).type)}, …]`;
      case "ZodEnum":
        return (def as unknown as { values: string[] }).values.map((v) => `"${v}"`).join("|");
      case "ZodString": {
        const checks = (def as unknown as { checks?: { kind: string }[] }).checks ?? [];
        if (checks.some((c) => c.kind === "uuid")) return "uuid";
        if (checks.some((c) => c.kind === "email")) return "email";
        if (checks.some((c) => c.kind === "datetime")) return "iso-datetime";
        return "string";
      }
      case "ZodNumber":
        return "number";
      case "ZodBoolean":
        return "boolean";
      default:
        return "value";
    }
  };
  return walk(schema);
}
