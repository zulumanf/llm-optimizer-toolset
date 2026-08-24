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
import {
  approveEnrichmentProposal,
  enrichProspect,
  listEnrichmentProposals,
  rejectEnrichmentProposal,
} from "@/lib/prospects/enrichment";
import {
  listDiscoveryCandidates,
  reviewDiscoveryCandidate,
  runProspectDiscovery,
} from "@/lib/prospects/discovery";
import { draftMarketPack, installMarketPackDraft } from "@/lib/markets/research";
import { bootstrapMarketBenchmark } from "@/lib/markets/bootstrap";
import {
  cancelCityProspecting,
  getCityProspecting,
  listCityPipelines,
  retryCityProspecting,
  startCityProspecting,
  type PipelineListFilter,
} from "@/lib/prospects/city-pipeline";
import { listScheduledOutbox } from "@/lib/prospects/scheduled-sends";
import { runSenseCheck } from "@/lib/prospects/sense-check";
import type { AgentCaller } from "@/lib/ai/agent";
import {
  cockpit,
  machineHealth,
} from "@/lib/prospects/dashboard";
import { cancelRun, retryFailedCells } from "@/lib/runs/service";
import {
  liftSuppression,
  listSuppressions,
  suppress,
  SUPPRESSION_REASONS,
} from "@/lib/outreach/suppression";
import {
  getActiveSenderIdentity,
  setSenderIdentity,
} from "@/lib/outreach/sender-identity";
import { stopSequence } from "@/lib/outreach/sequences";
import {
  approveAuditRefresh,
  dismissAuditRefresh,
  listAuditRefreshCandidates,
  prepareAuditRefreshCandidates,
} from "@/lib/prospects/refresh";
import { assertRole } from "@/lib/auth";
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
  /** The caller is the loop's injectable LLM transport (tests, CI) —
   * only LLM-backed tools forward it; the confirm path omits it. */
  run: (
    user: CurrentUser,
    input: Record<string, unknown>,
    caller?: AgentCaller
  ) => Promise<unknown>;
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
      "The prospecting cockpit: the cohort funnel (contacted → audit viewers → meaningfully engaged → replied → meeting), the prospects to act on first (priority order: conversation, CTA, high authority + high intent, deep engagement, multiple sessions or unresolved attribution, single visit, follow-up due), the possible-bottleneck diagnosis, and machine health (send cap, gmail status, research queue). Audit activity describes what the AUDIT PAGE received — never who viewed it. Opens are an upper bound.",
    tier: "read",
    schema: z.object({ launchId: z.string().uuid().optional() }),
    run: async (_user, input) => {
      const [c, health] = await Promise.all([
        cockpit({ launchId: typeof input.launchId === "string" ? input.launchId : undefined }),
        machineHealth(),
      ]);
      return {
        cohort: c.cohort,
        stageDrift: c.stageDrift,
        actToday: c.prospects
          .filter((p) => p.priorityTier <= 7)
          .slice(0, 15)
          .map((p) => ({
            prospectId: p.prospectId,
            businessName: p.businessName,
            qualityScore: p.qualityScore,
            intentLabel: p.intentLabel,
            intentScore: p.intentScore,
            priority: p.priorityTier,
            stage: p.stage,
            touches: p.sales.touches,
            auditSessions: p.engagement.sessions,
            meaningfullyEngaged: p.engagement.meaningfullyEngaged,
            attribution: p.engagement.attribution,
            lastActivityAt: p.engagement.lastActivityAt,
            recommendedAction: p.recommendedAction,
          })),
        health: {
          gmailStatus: health.gmailStatus,
          capUsed24h: health.capUsed24h,
          capLimit: health.capLimit,
          scheduledPending: health.scheduledPending,
          activeSuppressions: health.activeSuppressions,
          parkedSends: health.parkedSends,
          researchQueue: health.researchQueue.length,
        },
      };
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
    name: "get_city_prospecting",
    description:
      "Status and step-by-step log of a city prospecting pipeline (by city name or pipeline id) — answers 'how is X city going?'.",
    tier: "read",
    schema: z.object({ city: z.string().trim().min(2).max(120) }),
    run: async (_user, input) => {
      const row = await getCityProspecting(String(input.city));
      if (!row) throw new ClassifiedError("not_found", "No pipeline found for that city.");
      return row;
    },
  },
  {
    name: "list_city_pipelines",
    description:
      "Every city prospecting pipeline (default: active ones) with status, params, error, and the last log entries — answers 'what pipelines are running?'. Filter by status; failed rows show where they failed from (retry_city_pipeline resumes there).",
    tier: "read",
    schema: z.object({
      status: z.enum(["active", "failed", "completed", "cancelled", "all"]).default("active"),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    run: async (_user, input) =>
      listCityPipelines(input.status as PipelineListFilter, input.limit as number),
  },
  {
    name: "list_scheduled_sends",
    description:
      "The outbox: scheduled Gmail sends (soonest first, with attempts and any last error) and parked sends with the reason they parked. A row marked inFlight holds an unresolved claim — the message may or may not have left; it is never auto-retried, verify in the Gmail Sent folder.",
    tier: "read",
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
    run: async (_user, input) => listScheduledOutbox(input.limit as number),
  },
  {
    name: "list_discovery_candidates",
    description:
      "Staged discovery candidates awaiting review (default: pending), overall or per launch — the queue run_discovery fills. Each row carries confidence, provider, source URL, and the company resolution; review_discovery_candidate decides one.",
    tier: "read",
    schema: z.object({
      launch_id: uuid.optional(),
      status: z
        .enum(["pending", "approved", "dismissed", "duplicate", "all"])
        .default("pending"),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    run: async (_user, input) => {
      const rows = await listDiscoveryCandidates({
        ...(typeof input.launch_id === "string" ? { launchId: input.launch_id } : {}),
        ...(input.status !== "all" ? { status: input.status as string } : {}),
        limit: input.limit as number,
      });
      // Compact rows only — the raw payload can blow the transcript budget.
      return rows.map((r) => ({
        candidateId: r.id,
        launchName: r.launchName,
        businessName: r.businessName,
        provider: r.provider,
        sourceUrl: r.sourceUrl,
        confidence: r.confidence,
        provenance: r.provenance,
        status: r.status,
        resolution: r.resolution,
        retrievedAt: r.retrievedAt,
      }));
    },
  },
  {
    name: "list_enrichment_proposals",
    description:
      "A prospect's staged enrichment proposals still needing a decision (pending and failed only — decided ones leave this list), with payload, citations, and confidence. approve_enrichment or reject_enrichment_proposal decides one.",
    tier: "read",
    schema: z.object({ prospect_id: uuid }),
    run: async (_user, input) => listEnrichmentProposals(input.prospect_id as string),
  },
  {
    name: "list_suppressions",
    description:
      "The do-not-contact list: active suppressions (email/phone/domain) with reason and date; include_lifted shows history. Every send re-checks this — a suppressed value never receives outreach.",
    tier: "read",
    schema: z.object({
      scope: z.enum(["email", "phone", "domain"]).optional(),
      include_lifted: z.boolean().default(false),
      limit: z.number().int().min(1).max(100).default(30),
    }),
    run: async (_user, input) =>
      listSuppressions({
        ...(input.scope ? { scope: input.scope as "email" | "phone" | "domain" } : {}),
        includeLifted: input.include_lifted === true,
        limit: input.limit as number,
      }),
  },
  {
    name: "get_sender_identity",
    description:
      "The active legal sender of outbound email (name, company, postal address, reply-to) — CAN-SPAM identity. Null means not configured and sends will refuse.",
    tier: "read",
    schema: z.object({}),
    run: async () => (await getActiveSenderIdentity()) ?? { configured: false },
  },
  {
    name: "list_outreach_sequences",
    description:
      "Automation-driven outreach sequences with status, subject, recipient, step progress, and next send time. Never returns message bodies. stop_sequence halts one.",
    tier: "read",
    schema: z.object({
      status: z.enum(["active", "stopped", "completed", "all"]).default("active"),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    run: async (_user, input) => {
      const status = input.status as string;
      const where =
        status === "all"
          ? sql`true`
          : status === "stopped"
            ? sql`status like 'stopped_%'`
            : sql`status = ${status}`;
      return sql`
        select id, subject_kind, subject_ref, recipient_email, recipient_name,
          status, stop_reason, current_step, max_steps, next_send_at
        from outreach_sequences
        where ${where}
        order by coalesce(next_send_at, created_at) asc
        limit ${input.limit as number}
      `;
    },
  },
  {
    name: "list_audit_refresh_candidates",
    description:
      "The audit refresh queue: published audits whose project has a newer weekly run, with the metric delta, the new finding, preflight pass/warn counts, and the prior human finding (the pre-fill approve_audit_refresh requires). needs_attention rows must be resolved from the prospect page.",
    tier: "read",
    schema: z.object({}),
    run: async () => {
      const rows = await listAuditRefreshCandidates();
      // Compact rows: counts instead of preflight bodies, title without
      // the full explanation — transcript-budget discipline.
      return rows.map((r) => ({
        candidateId: r.id,
        status: r.status,
        error: r.error,
        businessName: r.businessName,
        launchName: r.launchName,
        prospectId: r.prospectId,
        runLabel: r.runLabel,
        runStartedAt: r.runStartedAt,
        findingTitle: r.findingTitle,
        delta: r.delta,
        preflight: {
          checks: r.preflight.length,
          failing: r.preflight.filter((c) => !c.ok).length,
        },
        publishedAt: r.publishedAt,
        viewCount: r.viewCount,
        priorHumanFinding: r.priorHumanFinding,
      }));
    },
  },
  {
    name: "list_launches",
    description:
      "Market launches with their market names and prospect counts — CHECK THIS BEFORE research_market: an existing launch means the city is already installed and discovery/bootstrap can run on it directly. Optional name filter.",
    tier: "read",
    schema: z.object({ name: z.string().trim().max(120).optional() }),
    run: async (_user, input) => {
      const name = typeof input.name === "string" ? `%${input.name}%` : "%";
      return sql`
        select l.id as launch_id, l.name, m.name as market, l.status,
          (select count(*)::int from prospects p
            where p.launch_id = l.id and p.archived_at is null) as prospects
        from market_launches l
        join markets m on m.id = l.market_id
        where l.archived_at is null
          and (l.name ilike ${name} or m.name ilike ${name})
        order by l.created_at desc
        limit 40
      `;
    },
  },
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
    name: "prepare_audit_refresh",
    description:
      "Stage refresh candidates from a finished run for every published audit its project feeds — idempotent per (prospect, run); nothing prospect-visible changes. Scheduled runs stage by default; pass force for a manual run (the documented backfill path). Returns prepared/needsAttention counts or notApplicable with why.",
    tier: "direct",
    schema: z.object({ run_id: uuid, force: z.boolean().optional() }),
    run: async (_user, input) =>
      prepareAuditRefreshCandidates({
        runId: input.run_id as string,
        ...(input.force === true ? { force: true } : {}),
      }),
  },
  {
    name: "run_sense_check",
    description:
      "Run the audit sense-check agent on a prospect's assembled audit content (evidence coherence, terminology, claims). Creates a reviewable check row — run this when publish_audit warns of a missing or stale sense-check, then publish.",
    tier: "direct",
    schema: z.object({ prospect_id: uuid }),
    run: async (user, input, caller) =>
      unwrapResult(await runSenseCheck(user, { prospectId: input.prospect_id }, caller)),
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
    name: "run_city_prospecting",
    description:
      "THE A-to-Z command: research the city (Perplexity, RealTrends-focused), install its market, discover and auto-create high-confidence prospects, benchmark them across the LLMs within the stated budget, then score and stage findings — all advanced in the background by the worker; check progress with get_city_prospecting. Requires operator confirmation of the budget.",
    tier: "confirm",
    schema: z.object({
      city_name: z.string().trim().min(2).max(120),
      state: z.string().trim().min(2).max(60),
      target_prospects: z.number().int().min(1).max(50).default(15),
      budget_usd: z.number().positive().max(100),
      segment: z.string().trim().max(160).optional(),
    }),
    summarize: (i) =>
      `Run A→Z prospecting for ${String(i.city_name)}, ${String(i.state)}: up to ${String(i.target_prospects ?? 15)} prospects, one benchmark run ≤ $${String(i.budget_usd)}`,
    run: async (user, input) =>
      unwrapResult(
        await startCityProspecting(user, {
          cityName: input.city_name,
          state: input.state,
          targetProspects: input.target_prospects ?? 15,
          budgetUsd: input.budget_usd,
          ...(input.segment ? { segment: input.segment } : {}),
        })
      ),
  },
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
  {
    name: "cancel_city_pipeline",
    description:
      "Cancel an active city prospecting pipeline. Confirmation required — it reverses the confirmed kickoff, and an in-flight benchmark run linked to it is cancelled too (captured cells are kept).",
    tier: "confirm",
    schema: z.object({
      pipeline_id: uuid,
      reason: z.string().trim().min(5).max(500),
    }),
    summarize: (i) =>
      `Cancel city pipeline ${String(i.pipeline_id).slice(0, 8)}… — ${String(i.reason)}`,
    run: async (user, input) =>
      unwrapResult(
        await cancelCityProspecting(user, {
          pipelineId: input.pipeline_id,
          reason: input.reason,
        })
      ),
  },
  {
    name: "retry_city_pipeline",
    description:
      "Retry a FAILED city prospecting pipeline from the status it failed at (shown as failedFromStatus in list_city_pipelines). Confirmation required — resumed lanes can spend provider budget. The worker advances it next tick.",
    tier: "confirm",
    schema: z.object({ pipeline_id: uuid }),
    summarize: (i) => `Retry failed city pipeline ${String(i.pipeline_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(await retryCityProspecting(user, { pipelineId: input.pipeline_id })),
  },
  {
    name: "cancel_scheduled_send",
    description:
      "Cancel a scheduled Gmail send before the worker claims it (idempotent on an unscheduled draft; refuses with a conflict while a claim is outstanding). The draft stays approved and can be rescheduled. Confirmation required — it reverses a confirmed schedule.",
    tier: "confirm",
    schema: z.object({ draft_id: uuid }),
    summarize: (i) => `Cancel the scheduled send of draft ${String(i.draft_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(await svc.cancelScheduledSend(user, { draftId: input.draft_id })),
  },
  {
    name: "cancel_run",
    description:
      "Cancel a pending or running benchmark run — it ends partial/cancelled and stops further provider spend; captured cells are kept. Confirmation required.",
    tier: "confirm",
    schema: z.object({ run_id: uuid }),
    summarize: (i) => `Cancel benchmark run ${String(i.run_id).slice(0, 8)}…`,
    run: async (user, input) => unwrapResult(await cancelRun(user, { runId: input.run_id })),
  },
  {
    name: "retry_failed_cells",
    description:
      "Re-execute a finished run's failed cells (run must be partial, completed, or failed — not still executing). The run re-enters the worker queue and spends provider budget on the retried cells. Confirmation required.",
    tier: "confirm",
    schema: z.object({ run_id: uuid }),
    summarize: (i) => `Retry failed cells of run ${String(i.run_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(await retryFailedCells(user, { runId: input.run_id })),
  },
  {
    name: "approve_audit_refresh",
    description:
      "Approve a refresh candidate: the prospect's published audit republishes from the new run under the SAME link. Requires the human-finding attestation (text + source label/url/date) — list_audit_refresh_candidates carries the prior one as pre-fill; only reuse it after confirming it still holds. A stale run needs acknowledge_stale; preflight warnings need acknowledge_warnings.reason. Confirmation required.",
    tier: "confirm",
    schema: z.object({
      candidate_id: uuid,
      human_finding: z.object({
        text: z.string().trim().min(20).max(600),
        source_label: z.string().trim().min(2).max(120),
        source_url: z.string().trim().url().max(1000),
        source_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      adoption_stat: z
        .object({
          text: z.string().trim().min(20).max(600),
          source_label: z.string().trim().min(2).max(120),
          source_url: z.string().trim().url().max(1000),
          source_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        })
        .optional(),
      acknowledge_stale: z.boolean().optional(),
      acknowledge_warnings: z
        .object({ reason: z.string().trim().min(10).max(500) })
        .optional(),
    }),
    summarize: (i) => `Approve audit refresh ${String(i.candidate_id).slice(0, 8)}… (republishes)`,
    run: async (user, input) => {
      const observation = (o: Record<string, unknown>) => ({
        text: o.text,
        sourceLabel: o.source_label,
        sourceUrl: o.source_url,
        sourceDate: o.source_date,
      });
      return unwrapResult(
        await approveAuditRefresh(user, {
          candidateId: input.candidate_id,
          humanFinding: observation(input.human_finding as Record<string, unknown>),
          ...(input.adoption_stat
            ? { adoptionStat: observation(input.adoption_stat as Record<string, unknown>) }
            : {}),
          ...(input.acknowledge_stale === true ? { acknowledgeStale: true } : {}),
          ...(input.acknowledge_warnings
            ? { acknowledgeWarnings: input.acknowledge_warnings }
            : {}),
        })
      );
    },
  },
  {
    name: "dismiss_audit_refresh",
    description:
      "Dismiss a refresh candidate — the published audit stays as it is; the next weekly run stages a fresh candidate. Confirmation required.",
    tier: "confirm",
    schema: z.object({
      candidate_id: uuid,
      reason: z.string().trim().max(500).optional(),
    }),
    summarize: (i) => `Dismiss audit refresh ${String(i.candidate_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(
        await dismissAuditRefresh(user, {
          candidateId: input.candidate_id,
          ...(input.reason ? { reason: input.reason } : {}),
        })
      ),
  },
  {
    name: "suppress_contact",
    description:
      "Add an email, phone, or domain to the do-not-contact list — no future outreach reaches it (lifting later is admin-only and permanently recorded). Confirmation required.",
    tier: "confirm",
    schema: z.object({
      scope: z.enum(["email", "phone", "domain"]),
      value: z.string().trim().min(1).max(320),
      reason: z.enum(SUPPRESSION_REASONS),
      detail: z.string().trim().max(500).optional(),
      project_id: uuid.optional(),
    }),
    summarize: (i) => `Suppress ${String(i.scope)} "${String(i.value)}" (${String(i.reason)})`,
    run: async (user, input) => {
      // Mirrors app/automation/actions.ts#suppressContact — the primitive
      // takes a tx; this adds no semantics of its own.
      const result = await sql.begin((tx) =>
        suppress(tx, {
          scope: input.scope as "email" | "phone" | "domain",
          value: input.value as string,
          reason: input.reason as (typeof SUPPRESSION_REASONS)[number],
          detail: (input.detail as string | undefined) ?? "",
          projectId: (input.project_id as string | undefined) ?? null,
          userId: user.id,
        })
      );
      return { suppressed: true, alreadySuppressed: result.alreadySuppressed };
    },
  },
  {
    name: "lift_suppression",
    description:
      "Lift a suppression entry, reopening contact — admin only, and the reason is recorded permanently. Confirmation required.",
    tier: "confirm",
    schema: z.object({
      suppression_id: uuid,
      reason: z.string().trim().min(3).max(500),
    }),
    summarize: (i) =>
      `Lift suppression ${String(i.suppression_id).slice(0, 8)}… — ${String(i.reason)}`,
    run: async (user, input) => {
      // Mirrors app/automation/actions.ts#liftContactSuppression: lifting
      // a do-not-contact instruction is an admin decision, always.
      assertRole(user, "admin");
      const lifted = await sql.begin((tx) =>
        liftSuppression(tx, {
          id: input.suppression_id as string,
          userId: user.id,
          reason: input.reason as string,
        })
      );
      return { lifted };
    },
  },
  {
    name: "set_sender_identity",
    description:
      "Replace the active legal sender of outbound email (CAN-SPAM: real name, company, physical postal address, reply-to). Admin only. Confirmation required.",
    tier: "confirm",
    schema: z.object({
      sender_name: z.string().trim().min(2).max(120),
      company_name: z.string().trim().min(2).max(120),
      postal_address: z.string().trim().min(10).max(300),
      reply_to_email: z.string().trim().email(),
    }),
    summarize: (i) =>
      `Set sender identity to ${String(i.sender_name)} <${String(i.reply_to_email)}>, ${String(i.company_name)}`,
    run: async (user, input) =>
      unwrapResult(
        await setSenderIdentity(user, {
          senderName: input.sender_name,
          companyName: input.company_name,
          postalAddress: input.postal_address,
          replyToEmail: input.reply_to_email,
        })
      ),
  },
  {
    name: "stop_sequence",
    description:
      "Stop an active outreach sequence (operator decision — recorded as a manual stop); its queued draft messages are cancelled so nothing sendable remains. Confirmation required.",
    tier: "confirm",
    schema: z.object({
      sequence_id: uuid,
      detail: z.string().trim().min(5).max(500),
    }),
    summarize: (i) =>
      `Stop outreach sequence ${String(i.sequence_id).slice(0, 8)}… — ${String(i.detail)}`,
    run: async (user, input) =>
      // Mirrors app/automation/actions.ts#stopOutreachSequence; chat stops
      // are always 'manual' — opted_out/bounced stay inbound-signal verbs.
      sql.begin((tx) =>
        stopSequence(tx, {
          sequenceId: input.sequence_id as string,
          reason: "manual",
          detail: input.detail as string,
          userId: user.id,
        })
      ),
  },
  {
    name: "review_discovery_candidate",
    description:
      "Approve or dismiss a pending discovery candidate. Approval resolves the company and creates the prospect through the provenance-stamped path (a same-name conflict records it as duplicate); dismissal discards the staged research. Confirmation required either way.",
    tier: "confirm",
    schema: z.object({
      candidate_id: uuid,
      decision: z.enum(["approve", "dismiss"]),
      company_id: uuid.optional(),
    }),
    summarize: (i) =>
      `${i.decision === "approve" ? "Approve" : "Dismiss"} discovery candidate ${String(i.candidate_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(
        await reviewDiscoveryCandidate(user, {
          candidateId: input.candidate_id,
          decision: input.decision,
          ...(typeof input.company_id === "string" ? { companyId: input.company_id } : {}),
        })
      ),
  },
  {
    name: "reject_enrichment_proposal",
    description:
      "Reject a staged enrichment proposal (the approve_enrichment twin) — nothing it proposed is written, and the decision is audited with the optional reason. Confirmation required.",
    tier: "confirm",
    schema: z.object({
      proposal_id: uuid,
      reason: z.string().trim().max(500).optional(),
    }),
    summarize: (i) => `Reject enrichment proposal ${String(i.proposal_id).slice(0, 8)}…`,
    run: async (user, input) =>
      unwrapResult(
        await rejectEnrichmentProposal(user, {
          proposalId: input.proposal_id,
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
  rawInput: Record<string, unknown>,
  caller?: AgentCaller
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
  return tool.run(user, parsed.data as Record<string, unknown>, caller);
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
