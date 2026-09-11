/**
 * Domain nodes — the ones that make this an AI-market-authority automation
 * layer rather than a generic workflow engine.
 *
 * Everything here manipulates a domain object the platform owns as system of
 * record: outreach sequences, suppression, meeting briefs and decisions, support
 * requests, billing events, evidence packets, domain events. None of it is
 * expressible as "call an HTTP endpoint", which is precisely the argument for
 * building this layer instead of configuring a generic one.
 */
import { sql } from "@/db/client";
import { resolve, resolveArray, resolveObject, resolveString } from "@/lib/automation/nodes/paths";
import { buildEvidencePacket, recordPacket } from "@/lib/knowledge/packet";
import { buildValidatedPacket } from "@/lib/knowledge/context/builder";
import { getPacketTemplate } from "@/lib/knowledge/context/templates";
import { publishEvent } from "@/lib/events/bus";
import { checkSuppression, suppress } from "@/lib/outreach/suppression";
import {
  addMessage,
  applyInboundSignal,
  createSequence,
  hashBody,
  markMessageSent,
  sequenceForSubject,
  verifyClaimsSupported,
  type OutreachClaim,
} from "@/lib/outreach/sequences";
import { runModeFor } from "@/lib/automation/testmode";
import { prepareAuditRefreshCandidates } from "@/lib/prospects/refresh";
import type { NodeHandler, NodeResult } from "@/lib/workflow/types";

// ------------------------------------------------------------------ evidence

/**
 * `dom.build_evidence_packet` — assembles the task-scoped packet an agent is
 * allowed to see. Privacy filtering happens inside `buildEvidencePacket`, at
 * retrieval time, so an agent cannot be handed a restricted claim by a template
 * that forgot to filter.
 */
const buildPacket: NodeHandler = async (ctx): Promise<NodeResult> => {
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "an evidence packet requires a client scope" };
  }

  // Spec 022: when the node names a template, it gets a task-specific packet —
  // token-budgeted, instructions separated from facts, every omission recorded.
  // Nodes that name no template keep the legacy path, which now delegates its
  // claim selection to the same implementation.
  const templateKey = ctx.config.template as string | undefined;
  if (templateKey) {
    return buildTemplatedPacket(ctx, templateKey);
  }

  const audience = (ctx.config.audience as "internal" | "client" | "public") ?? "internal";
  const packet = await buildEvidencePacket({
    projectId: ctx.projectId,
    purpose: String(ctx.config.purpose ?? ctx.nodeKey),
    audience,
    categories: (ctx.config.categories as string[] | undefined) ?? undefined,
    claimKeys: (ctx.config.claimKeys as string[] | undefined) ?? undefined,
    workflowRunId: ctx.runId,
  });
  const packetId = await sql.begin((tx) =>
    recordPacket(tx, packet, { workflowRunId: ctx.runId, nodeRunId: null })
  );

  const staleCount = packet.claims.filter((claim) => claim.stale).length;

  // Integrity, stated rather than left unknown. Every artifact this platform
  // stores carries a sha256 (migration 011); a packet whose artifacts all have
  // one has verifiable integrity, one with an artifact missing its hash does
  // not, and a packet with no hashable artifacts has nothing to verify. The
  // evidence gate treats `null` as "could not evaluate" and refuses, so the
  // distinction between "nothing to check" and "could not check" matters.
  const [artifacts] = await sql`
    select
      count(*)::int as total,
      count(*) filter (where sha256 is not null and sha256 <> '')::int as hashed
    from evidence_artifacts a
    join responses r on r.id = a.response_id
    join runs run on run.id = r.run_id
    where run.project_id = ${ctx.projectId}
  `;
  const artifactTotal = Number(artifacts?.total ?? 0);
  const artifactHashed = Number(artifacts?.hashed ?? 0);
  const hashesValid = artifactTotal === 0 ? true : artifactHashed === artifactTotal;

  return {
    outcome: "succeeded",
    output: {
      packetId,
      hashesValid,
      artifactCount: artifactTotal,
      hashedArtifactCount: artifactHashed,
      integrityNote:
        artifactTotal === 0
          ? "No hashed artifacts in this packet; there is nothing to verify."
          : `${artifactHashed} of ${artifactTotal} artifacts carry a recorded hash.`,
      claimCount: packet.claims.length,
      sourceCount: packet.sources.length,
      contradictionCount: packet.contradictions.length,
      staleClaimCount: staleCount,
      // Disclaimers the packet itself decided are mandatory. A caller that
      // drops these is misrepresenting the evidence.
      requiredDisclaimers: packet.requiredDisclaimers,
      withheldClaimCount: packet.withheldClaimIds.length,
      // The shape `ctl.evidence_gate` expects, so the two compose without glue.
      sampleSize: packet.claims.length,
      rawEvidenceCount: packet.sources.length,
      evidenceKinds: [...new Set(packet.sources.map((source) => source.kind))],
      classifiedCount: packet.claims.length,
      partialFailureCount: 0,
      partialFailureDisclosed: true,
      requiredUpstreamTotal: 1,
      requiredUpstreamCompleted: 1,
      audience,
      claims: packet.claims,
      contradictions: packet.contradictions,
      evidenceIds: packet.claims.flatMap((claim) => claim.evidenceIds),
    },
  };
};

/**
 * The spec-022 path: a packet built to a named task template.
 *
 * Validation runs before the packet is returned, so a node cannot hand an agent
 * a packet that failed its checks. A validation failure is a `safe_stop`, not a
 * retry: nothing about running the same query again will make a restricted
 * claim allowed or a missing instruction appear.
 */
async function buildTemplatedPacket(
  ctx: Parameters<NodeHandler>[0],
  templateKey: string
): Promise<NodeResult> {
  const template = getPacketTemplate(templateKey);
  if (!template) {
    return {
      outcome: "failed_terminal",
      error: `No context-packet template named "${templateKey}". Declare it in lib/knowledge/context/templates.ts.`,
    };
  }

  try {
    const { packet, packetId } = await buildValidatedPacket(
      {
        projectId: ctx.projectId!,
        templateKey,
        taskObjective: String(ctx.config.objective ?? ctx.nodeKey),
        agentKey: (ctx.config.agentKey as string | undefined) ?? undefined,
        workflowKey: (ctx.config.workflowKey as string | undefined) ?? undefined,
        workflowRunId: ctx.runId,
        additionalCategories: (ctx.config.categories as string[] | undefined) ?? undefined,
        claimKeys: (ctx.config.claimKeys as string[] | undefined) ?? undefined,
        tokenBudget: (ctx.config.tokenBudget as number | undefined) ?? undefined,
      },
      { workflowRunId: ctx.runId, nodeRunId: null }
    );

    const claims = packet.items.filter((item) => item.itemType === "claim" && item.included);
    const contradictions = packet.items.filter(
      (item) => item.itemType === "contradiction" && item.included
    );
    const evidence = packet.items.filter(
      (item) => item.itemType === "evidence" && item.included
    );

    if (template.requiresClaims && claims.length === 0) {
      return {
        outcome: "safe_stop",
        reason:
          "no approved claims are available for this client — proceeding would require inventing facts",
        output: { packetId, missingContext: packet.missingContext },
      };
    }

    return {
      outcome: "succeeded",
      output: {
        packetId,
        templateKey,
        tokenCount: packet.tokenCount,
        tokenBudget: packet.tokenBudget,
        claimCount: claims.length,
        contradictionCount: contradictions.length,
        sourceCount: evidence.length,
        withheldClaimCount: packet.withheldClaimIds.length,
        excludedItemCount: packet.items.filter((item) => !item.included).length,
        missingContext: packet.missingContext,
        requiredDisclaimers: packet.requiredDisclaimers,
        freshness: packet.freshness,
        contentHash: packet.contentHash,
        // The shape `ctl.evidence_gate` consumes, so the two still compose.
        sampleSize: claims.length,
        rawEvidenceCount: evidence.length,
        evidenceKinds: [...new Set(evidence.map((item) => item.label))],
        classifiedCount: claims.length,
        partialFailureCount: 0,
        partialFailureDisclosed: true,
        requiredUpstreamTotal: 1,
        requiredUpstreamCompleted: 1,
      },
    };
  } catch (err) {
    return {
      outcome: "safe_stop",
      reason: `the context packet could not be built safely: ${(err as Error).message}`,
    };
  }
}

/**
 * `dom.build_prospect_evidence` — the prospect-side counterpart to the client
 * evidence packet.
 *
 * A prospect is not a client: there is no approved knowledge graph to draw on,
 * so this assembles what we actually observed about them from public data and
 * from our own measurement run. It requires no client scope, and it produces the
 * same shape `ctl.evidence_gate` consumes — so the gate can hold outreach to the
 * same standard as client work without pretending the sources are the same.
 */
const buildProspectEvidence: NodeHandler = async (ctx): Promise<NodeResult> => {
  const observations = await resolveArray(ctx, String(ctx.config.observationsPath ?? ""));
  const profile = await resolveObject(ctx, String(ctx.config.profilePath ?? "payload"));

  // What we can actually point at. A public page we fetched and a measurement
  // we ran are the only two kinds of evidence outreach may rest on.
  const evidenceKinds: string[] = [];
  if (typeof profile.website === "string" && profile.website.length > 0) {
    evidenceKinds.push("public_page");
  }
  if (observations.length > 0) evidenceKinds.push("measurement");

  const sampleSize = observations.length;
  return {
    outcome: "succeeded",
    output: {
      // A prospect audit stores no hashed artifacts of its own, so there is
      // nothing to verify — which is different from "we could not verify".
      hashesValid: true,
      integrityNote: "Prospect evidence is read directly from public sources; no stored artifacts to hash.",
      subject: {
        name: String(profile.name ?? ""),
        company: String(profile.company ?? ""),
        website: String(profile.website ?? ""),
        market: String(profile.market ?? ""),
      },
      observations,
      // The gate's contract. Stated explicitly rather than inferred, so a thin
      // evidence base blocks the outreach instead of quietly weakening it.
      sampleSize,
      rawEvidenceCount: evidenceKinds.length,
      evidenceKinds,
      classifiedCount: sampleSize,
      lowConfidenceCount: 0,
      lowConfidenceRoutedCount: 0,
      partialFailureCount: 0,
      partialFailureDisclosed: true,
      requiredUpstreamTotal: 1,
      requiredUpstreamCompleted: 1,
      // A prospect audit has no approved claims — saying so prevents a drafting
      // agent from being handed an empty packet and inferring facts into it.
      claims: [],
      evidenceIds: [],
      note:
        sampleSize === 0
          ? "No measurement observations available; any outreach claim must cite a public page directly."
          : `${sampleSize} measurement observation(s) available.`,
    },
  };
};

// -------------------------------------------------------------- audit refresh

/**
 * `dom.prepare_audit_refresh` — spec 075. Prepares refresh candidates for
 * every published prospect audit fed by the run in the trigger payload.
 * Preparation only: publishing stays behind `approveAuditRefresh`, a staff
 * click in the refresh queue. Safe-stops (rather than failing) on runs the
 * queue does not consume — manual runs, non-prospect projects.
 */
const prepareAuditRefresh: NodeHandler = async (ctx): Promise<NodeResult> => {
  const runId = await resolveString(ctx, String(ctx.config.runIdPath ?? "payload.runId"));
  if (!runId) {
    return { outcome: "failed_terminal", error: "no runId in the trigger payload" };
  }
  const result = await prepareAuditRefreshCandidates({
    runId,
    force: ctx.config.force === true,
  });
  if (result.notApplicable) {
    return {
      outcome: "safe_stop",
      reason: `no refresh candidates prepared: ${result.notApplicable}`,
    };
  }
  return {
    outcome: "succeeded",
    output: {
      runId: result.runId,
      prepared: result.prepared,
      needsAttention: result.needsAttention,
      skipped: result.skipped,
    },
  };
};

// ------------------------------------------------------------------ outreach

/** `dom.start_outreach_sequence` — refuses a suppressed recipient up front. */
const startSequence: NodeHandler = async (ctx): Promise<NodeResult> => {
  const subject = await resolveObject(ctx, String(ctx.config.subjectPath ?? "")) as {
    id?: string;
    email?: string;
    name?: string;
  };
  const email = String(subject.email ?? "");
  if (email.length === 0) {
    return { outcome: "failed_terminal", error: "outreach needs a recipient email" };
  }

  // The subject reference is what every later lookup joins on, so the template
  // states it explicitly rather than the node guessing at an id field name. The
  // email is a last resort, not a default.
  const explicitRef = await resolveString(ctx, String(ctx.config.subjectRefPath ?? ""));
  const subjectRef =
    explicitRef.length > 0 ? explicitRef : String(subject.id ?? email);

  const result = await sql.begin((tx) =>
    createSequence(tx, {
      projectId: ctx.projectId,
      workflowRunId: ctx.runId,
      subjectKind: (ctx.config.subjectKind as "prospect" | "client" | "journalist" | "partner") ?? "prospect",
      subjectRef,
      recipientEmail: email,
      recipientName: String(subject.name ?? ""),
      maxSteps: Number(ctx.config.maxSteps ?? 4),
    })
  );

  if (result.refused) {
    // A suppressed recipient is a correct stop, not an error.
    return {
      outcome: "safe_stop",
      reason: `outreach refused: ${result.reason}`,
      output: { refused: true, reason: result.reason },
    };
  }
  return {
    outcome: "succeeded",
    output: { sequenceId: result.sequenceId, recipientEmail: email, step: 1 },
  };
};

/**
 * `dom.draft_outreach_message` — persists an agent's draft as step N, refusing
 * any draft with an unsupported factual claim. The refusal is the product: a
 * message that cannot be supported must not exist as a sendable artifact.
 */
const draftMessage: NodeHandler = async (ctx): Promise<NodeResult> => {
  const sequenceId = await resolveString(ctx, String(ctx.config.sequenceIdPath ?? ""));
  const draft = await resolveObject(ctx, String(ctx.config.draftPath ?? "")) as {
    subject?: string;
    body?: string;
    claims?: OutreachClaim[];
    omittedForLackOfEvidence?: string[];
  };
  if (sequenceId.length === 0) {
    return { outcome: "failed_terminal", error: "draft_outreach_message needs a sequence id" };
  }
  const claims = draft.claims ?? [];
  const verdict = verifyClaimsSupported(claims);
  if (!verdict.ok) {
    return {
      outcome: "safe_stop",
      reason: `draft contains unsupported factual claims and will not be stored as sendable: ${verdict.unsupported.join(" | ")}`,
      output: { unsupported: verdict.unsupported },
    };
  }

  const step = Number(ctx.config.step ?? 1);
  const subject = String(draft.subject ?? "");
  const body = String(draft.body ?? "");
  const evidenceIds = [...new Set(claims.flatMap((claim) => claim.evidenceIds))];

  try {
    const stored = await sql.begin((tx) =>
      addMessage(tx, { sequenceId, step, subject, body, claims, evidenceIds })
    );
    return {
      outcome: "succeeded",
      output: {
        messageId: stored.messageId,
        bodyHash: stored.bodyHash,
        sequenceId,
        step,
        subject,
        body,
        // The claims themselves, not just a count: they are what an approver
        // checks, and for prospect outreach they carry the source URLs that
        // stand in for stored evidence ids.
        claims,
        claimCount: claims.length,
        evidenceIds,
        omittedForLackOfEvidence: draft.omittedForLackOfEvidence ?? [],
      },
    };
  } catch (err) {
    return {
      outcome: "failed_terminal",
      error: err instanceof Error ? err.message : "could not store the draft",
    };
  }
};

/** `dom.record_outreach_sent` — bookkeeping after a successful send. */
const recordSent: NodeHandler = async (ctx): Promise<NodeResult> => {
  const messageId = await resolveString(ctx, String(ctx.config.messageIdPath ?? ""));
  const sendResult = await resolveObject(ctx, String(ctx.config.sendResultPath ?? "")) as {
    sent?: boolean;
    messageId?: string;
  };
  if (messageId.length === 0) {
    return { outcome: "failed_terminal", error: "record_outreach_sent needs a message id" };
  }
  if (sendResult.sent !== true) {
    return {
      outcome: "skipped",
      reason: "no send occurred, so nothing is recorded as sent",
      output: { recorded: false },
    };
  }
  const followUpDays = Number(ctx.config.followUpDays ?? 4);
  await sql.begin((tx) =>
    markMessageSent(tx, {
      messageId,
      providerMessageId: sendResult.messageId ?? null,
      nextSendAt: new Date(Date.now() + followUpDays * 86_400_000),
    })
  );
  return {
    outcome: "succeeded",
    output: { recorded: true, nextFollowUpInDays: followUpDays },
  };
};

/**
 * `dom.apply_reply_signal` — the single interpreter of the four stop conditions.
 * Every inbound channel routes through here so none can invent its own rules.
 */
const applyReply: NodeHandler = async (ctx): Promise<NodeResult> => {
  const classification = await resolveObject(ctx, String(ctx.config.classificationPath ?? "")) as {
    shouldStopSequence?: boolean;
    isOptOut?: boolean;
    meetingRequested?: boolean;
    intent?: string;
  };
  const sequenceId = await resolveString(ctx, String(ctx.config.sequenceIdPath ?? ""));
  if (sequenceId.length === 0) {
    return { outcome: "failed_terminal", error: "apply_reply_signal needs a sequence id" };
  }

  const signal: "reply" | "opt_out" | "bounce" | "meeting_booked" =
    classification.isOptOut === true
      ? "opt_out"
      : classification.meetingRequested === true
        ? "meeting_booked"
        : "reply";

  if (classification.shouldStopSequence !== true && signal === "reply") {
    // An out-of-office, typically. The sequence continues, and we say why.
    return {
      outcome: "succeeded",
      output: {
        stopped: false,
        reason: `intent "${classification.intent ?? "unknown"}" does not stop the sequence`,
      },
    };
  }

  const result = await sql.begin((tx) =>
    applyInboundSignal(tx, { sequenceId, signal, detail: classification.intent })
  );
  return {
    outcome: "succeeded",
    output: { stopped: result.stopped, signal, intent: classification.intent ?? null },
  };
};

/** `dom.suppress_recipient` — an explicit suppression from a workflow. */
const suppressRecipient: NodeHandler = async (ctx): Promise<NodeResult> => {
  const email = await resolveString(ctx, String(ctx.config.emailPath ?? ""));
  if (email.length === 0) {
    return { outcome: "failed_terminal", error: "suppress_recipient needs an email" };
  }
  const result = await sql.begin((tx) =>
    suppress(tx, {
      scope: "email",
      value: email,
      reason: (ctx.config.reason as "opt_out" | "hard_bounce" | "complaint" | "client_request" | "legal_request" | "manual") ?? "manual",
      detail: String(ctx.config.detail ?? `workflow run ${ctx.runId}`),
      // Suppressions from a workflow are global by default: a person who asked
      // to stop hearing from us meant all of us.
      projectId: ctx.config.projectScoped === true ? ctx.projectId : null,
      userId: null,
    })
  );
  return {
    outcome: "succeeded",
    output: { suppressed: true, alreadySuppressed: result.alreadySuppressed },
  };
};

/** `dom.check_suppression` — a read-only gate a graph can branch on. */
const checkSuppressed: NodeHandler = async (ctx): Promise<NodeResult> => {
  const email = await resolveString(ctx, String(ctx.config.emailPath ?? ""));
  if (email.length === 0) {
    return { outcome: "failed_terminal", error: "check_suppression needs an email" };
  }
  const check = await checkSuppression({ email, projectId: ctx.projectId });
  return {
    outcome: "succeeded",
    output: {
      suppressed: check.suppressed,
      matchedScope: check.matchedScope,
      reason: check.reason,
      global: check.global,
    },
  };
};

/** `dom.find_sequence` — resolve an existing sequence for a subject. */
const findSequence: NodeHandler = async (ctx): Promise<NodeResult> => {
  const subjectRef = await resolveString(ctx, String(ctx.config.subjectRefPath ?? ""));
  const sequence = await sequenceForSubject(ctx.projectId, subjectRef);
  return {
    outcome: "succeeded",
    output: {
      found: sequence !== null,
      sequenceId: sequence?.id ?? null,
      status: sequence?.status ?? null,
      currentStep: sequence?.currentStep ?? 0,
      active: sequence?.status === "active",
    },
  };
};

// ------------------------------------------------------------------ meetings

const recordMeetingBrief: NodeHandler = async (ctx): Promise<NodeResult> => {
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a meeting brief requires a client scope" };
  }
  const brief = await resolveObject(ctx, String(ctx.config.briefPath ?? "")) as Record<
    string,
    unknown
  >;
  const meeting = await resolveObject(ctx, String(ctx.config.meetingPath ?? "")) as {
    id?: string;
    title?: string;
    startsAt?: string;
    attendees?: unknown[];
  };
  // Which sources were actually available. A thin brief is then explained
  // rather than mysterious.
  const sourcesUsed = (ctx.config.sourcesUsed as string[] | undefined) ?? [];
  const sourcesMissing = (ctx.config.sourcesMissing as string[] | undefined) ?? [];

  const [row] = await sql`
    insert into meeting_briefs (
      project_id, workflow_run_id, external_event_id, title, starts_at,
      attendees, brief, sources_used, sources_missing
    ) values (
      ${ctx.projectId}, ${ctx.runId}, ${String(meeting.id ?? "")},
      ${String(meeting.title ?? "Untitled meeting")},
      ${meeting.startsAt ? new Date(meeting.startsAt) : null},
      ${sql.json((meeting.attendees ?? []) as never)},
      ${sql.json(brief as never)}, ${sourcesUsed}, ${sourcesMissing}
    )
    on conflict (project_id, external_event_id)
      where external_event_id <> ''
    do update set brief = excluded.brief, sources_used = excluded.sources_used,
                  sources_missing = excluded.sources_missing
    returning id
  `;
  return {
    outcome: "succeeded",
    output: {
      briefId: (row?.id as string) ?? null,
      sourcesUsed,
      sourcesMissing,
      complete: sourcesMissing.length === 0,
    },
  };
};

/**
 * `dom.record_meeting_decisions` — turns extracted decisions and actions into
 * tracked rows. An action item with no owner is stored with an empty owner and
 * flagged, never assigned to someone by guesswork.
 */
const recordDecisions: NodeHandler = async (ctx): Promise<NodeResult> => {
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "meeting decisions require a client scope" };
  }
  const summary = await resolveObject(ctx, String(ctx.config.summaryPath ?? "")) as {
    decisions?: { summary: string; owner?: string }[];
    actionItems?: { summary: string; owner?: string; dueDate?: string }[];
    unresolvedQuestions?: string[];
    relationshipNotes?: string[];
    confidence?: number;
  };
  const briefId = await resolve(ctx, String(ctx.config.briefIdPath ?? ""));

  const rows: { kind: string; summary: string; owner: string; dueDate: string | null }[] = [];
  for (const decision of summary.decisions ?? []) {
    rows.push({ kind: "decision", summary: decision.summary, owner: decision.owner ?? "", dueDate: null });
  }
  for (const item of summary.actionItems ?? []) {
    const due = item.dueDate && Number.isFinite(Date.parse(item.dueDate)) ? item.dueDate : null;
    rows.push({ kind: "action_item", summary: item.summary, owner: item.owner ?? "", dueDate: due });
  }
  for (const question of summary.unresolvedQuestions ?? []) {
    rows.push({ kind: "question", summary: question, owner: "", dueDate: null });
  }
  for (const note of summary.relationshipNotes ?? []) {
    rows.push({ kind: "relationship_note", summary: note, owner: "", dueDate: null });
  }

  let inserted = 0;
  await sql.begin(async (tx) => {
    for (const row of rows) {
      await tx`
        insert into meeting_decisions (
          brief_id, project_id, kind, summary, owner, due_date,
          related_workflow_key, evidence_source, confidence
        ) values (
          ${briefId === undefined || briefId === null ? null : String(briefId)},
          ${ctx.projectId}, ${row.kind}, ${row.summary}, ${row.owner},
          ${row.dueDate}, ${String(ctx.config.workflowKey ?? "")},
          ${String(ctx.config.evidenceSource ?? "meeting notes")},
          ${summary.confidence ?? null}
        )
      `;
      inserted += 1;
    }
  });

  const unowned = rows.filter((row) => row.kind === "action_item" && row.owner.length === 0);
  return {
    outcome: "succeeded",
    output: {
      recorded: inserted,
      decisions: (summary.decisions ?? []).length,
      actionItems: (summary.actionItems ?? []).length,
      // Surfaced so an operator can assign them, rather than the system guessing.
      unownedActionItems: unowned.length,
      needsOwnerAssignment: unowned.map((row) => row.summary),
    },
  };
};

// ------------------------------------------------------------------- support

const recordSupportRequest: NodeHandler = async (ctx): Promise<NodeResult> => {
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a support request requires a client scope" };
  }
  const message = await resolveObject(ctx, String(ctx.config.messagePath ?? "")) as {
    senderEmail?: string;
    subject?: string;
    body?: string;
  };
  const triage = await resolveObject(ctx, String(ctx.config.triagePath ?? "")) as {
    category?: string;
    urgency?: string;
    autoResponseAllowed?: boolean;
    suggestedResponse?: string;
    escalationReason?: string;
    confidence?: number;
  };

  const [row] = await sql`
    insert into support_requests (
      project_id, workflow_run_id, sender_email, subject, body, category, urgency,
      auto_response_allowed, confidence, resolution, response_body, escalation_reason
    ) values (
      ${ctx.projectId}, ${ctx.runId}, ${String(message.senderEmail ?? "")},
      ${String(message.subject ?? "")}, ${String(message.body ?? "")},
      ${triage.category ?? null},
      ${["low", "normal", "high", "critical"].includes(String(triage.urgency)) ? String(triage.urgency) : "normal"},
      ${triage.autoResponseAllowed === true}, ${triage.confidence ?? null},
      'pending', ${triage.suggestedResponse ?? null}, ${triage.escalationReason ?? null}
    )
    returning id
  `;
  return {
    outcome: "succeeded",
    output: {
      supportRequestId: (row?.id as string) ?? null,
      category: triage.category ?? null,
      autoResponseAllowed: triage.autoResponseAllowed === true,
      escalationReason: triage.escalationReason ?? null,
    },
  };
};

// ------------------------------------------------------------------- billing

/**
 * `dom.compute_invoice_amount` — the invoice total, computed from the contract
 * record. Deterministic, and marked as such so the integration node will accept
 * it. An LLM is nowhere in this path, by construction.
 */
const computeInvoiceAmount: NodeHandler = async (ctx): Promise<NodeResult> => {
  const contract = await resolveObject(ctx, String(ctx.config.contractPath ?? "")) as {
    monthlyAmountCents?: number;
    periods?: number;
    oneOffAmountCents?: number;
    currency?: string;
    contractRef?: string;
  };
  const monthly = Number(contract.monthlyAmountCents ?? 0);
  const periods = Number(contract.periods ?? 1);
  const oneOff = Number(contract.oneOffAmountCents ?? 0);

  if (!Number.isInteger(monthly) || !Number.isInteger(oneOff) || monthly < 0 || oneOff < 0) {
    return {
      outcome: "failed_terminal",
      error: "contract amounts must be non-negative integer cents",
    };
  }
  if (!Number.isInteger(periods) || periods < 1) {
    return { outcome: "failed_terminal", error: "contract periods must be a positive integer" };
  }
  const amountCents = monthly * periods + oneOff;
  if (amountCents <= 0) {
    return {
      outcome: "safe_stop",
      reason: "computed invoice amount is zero; refusing to raise an empty invoice",
    };
  }

  return {
    outcome: "succeeded",
    output: {
      amountCents,
      currency: contract.currency ?? "USD",
      contractRef: contract.contractRef ?? "",
      // The marker `int.billing_create_invoice` requires.
      computedBy: "deterministic",
      calculation: { monthlyAmountCents: monthly, periods, oneOffAmountCents: oneOff },
    },
  };
};

const recordBillingEvent: NodeHandler = async (ctx): Promise<NodeResult> => {
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "a billing event requires a client scope" };
  }
  const kind = String(ctx.config.kind ?? "");
  const invoice = await resolveObject(ctx, String(ctx.config.invoicePath ?? "")) as {
    externalInvoiceId?: string;
    amountCents?: number;
    currency?: string;
    dueDate?: string;
    contractRef?: string;
  };
  const [row] = await sql`
    insert into billing_events (
      project_id, workflow_run_id, kind, external_invoice_id, amount_cents,
      currency, due_date, contract_ref
    ) values (
      ${ctx.projectId}, ${ctx.runId}, ${kind},
      ${invoice.externalInvoiceId ?? null},
      ${invoice.amountCents ?? null}, ${invoice.currency ?? "USD"},
      ${invoice.dueDate ? new Date(invoice.dueDate) : null},
      ${invoice.contractRef ?? ""}
    )
    on conflict do nothing
    returning id
  `;
  return {
    outcome: "succeeded",
    output: { billingEventId: (row?.id as string) ?? null, kind, recorded: Boolean(row) },
  };
};

// -------------------------------------------------------------------- events

/**
 * `dom.publish_event` — publish a domain event from inside a workflow, carrying
 * the run's correlation so the causal chain stays intact.
 */
const publishDomainEvent: NodeHandler = async (ctx): Promise<NodeResult> => {
  const type = String(ctx.config.eventType ?? "");
  const payloadPath = String(ctx.config.payloadPath ?? "");
  const payload = (await resolve(ctx, payloadPath) ?? ctx.config.params ?? {}) as Record<
    string,
    unknown
  >;
  const upstreamEvent = (ctx.workflowInput.event ?? {}) as { correlationId?: string; id?: string };

  try {
    const result = await sql.begin((tx) =>
      publishEvent(tx, {
        type,
        projectId: ctx.projectId,
        source: "workflow",
        payload,
        workflowRunId: ctx.runId,
        correlationId: upstreamEvent.correlationId,
        causationId: upstreamEvent.id ?? null,
        dedupeKey:
          ctx.config.dedupeKey === undefined
            ? `run:${ctx.runId}:${ctx.nodeKey}:${ctx.fanKey}`
            : String(ctx.config.dedupeKey),
      })
    );
    return {
      outcome: "succeeded",
      output: { eventId: result.event.id, type, created: result.created },
    };
  } catch (err) {
    return {
      outcome: "failed_terminal",
      error: err instanceof Error ? err.message : `could not publish ${type}`,
    };
  }
};

/**
 * `dom.record_action_outcome` — links an action this workflow took to the
 * outcome graph (spec 019), so "did the thing we did work?" stays answerable.
 */
const recordActionOutcome: NodeHandler = async (ctx): Promise<NodeResult> => {
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "an action outcome requires a client scope" };
  }
  const action = await resolveObject(ctx, String(ctx.config.actionPath ?? "")) as {
    actionType?: string;
    hypothesis?: string;
    promptClusterKeys?: string[];
    landingUrls?: string[];
    expectedDaysToImpact?: number;
    evidenceIds?: string[];
  };
  // `effectiveness` starts at 'insufficient_measurement' — the honest default.
  // A row created today has not been measured, and the outcome graph must not
  // read an unmeasured action as one that had no effect.
  const [row] = await sql`
    insert into action_outcomes (
      project_id, workflow_run_id, action_type, hypothesis,
      prompt_cluster_keys, landing_urls, expected_days_to_impact,
      effectiveness, evidence_ids
    ) values (
      ${ctx.projectId}, ${ctx.runId},
      ${String(action.actionType ?? ctx.config.actionType ?? "automation")},
      ${String(action.hypothesis ?? ctx.config.hypothesis ?? "")},
      ${action.promptClusterKeys ?? []}, ${action.landingUrls ?? []},
      ${action.expectedDaysToImpact ?? Number(ctx.config.expectedDaysToImpact ?? 30)},
      'insufficient_measurement', ${(action.evidenceIds ?? []).map(String)}::uuid[]
    )
    returning id
  `;
  return {
    outcome: "succeeded",
    output: {
      actionOutcomeId: (row?.id as string) ?? null,
      recorded: Boolean(row),
      effectiveness: "insufficient_measurement",
      note: "Effect is unmeasured until the scheduled remeasurement runs.",
    },
  };
};

/**
 * `dom.assemble_report_section` — collects computed metrics into a report
 * section, refusing any metric that cannot state its own denominator.
 */
const assembleReportSection: NodeHandler = async (ctx): Promise<NodeResult> => {
  const metricsPath = String(ctx.config.metricsPath ?? "");
  // A template may point at a single computed metric or at a list of them;
  // requiring a list would make one-metric sections need a wrapper node.
  const raw = await resolve(ctx, metricsPath);
  const metrics = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : raw !== null && typeof raw === "object"
      ? [raw as Record<string, unknown>]
      : [];

  const complete: Record<string, unknown>[] = [];
  const incomplete: { metric: string; missing: string[] }[] = [];
  for (const metric of metrics) {
    const missing: string[] = [];
    if (metric.numerator === undefined) missing.push("numerator");
    if (metric.denominator === undefined) missing.push("denominator");
    if (metric.sample === undefined) missing.push("sample");
    if (metric.calculationVersion === undefined) missing.push("calculationVersion");
    if (missing.length > 0) {
      incomplete.push({ metric: String(metric.name ?? "unnamed"), missing });
    } else {
      complete.push(metric);
    }
  }

  return {
    outcome: "succeeded",
    output: {
      section: String(ctx.config.section ?? ""),
      metrics: complete,
      metricCount: complete.length,
      // Disclosed, never dropped: a report that silently omits a metric reads
      // as though the metric was zero.
      incomplete,
      incompleteCount: incomplete.length,
      complete: incomplete.length === 0,
    },
  };
};

/** `dom.disclose_test_mode` — stamps a test run's artifacts as test data. */
const discloseTestMode: NodeHandler = async (ctx): Promise<NodeResult> => {
  const mode = await runModeFor(ctx.runId);
  return {
    outcome: "succeeded",
    output: {
      mode: mode.mode,
      test: mode.mode === "test",
      disclosure:
        mode.mode === "test"
          ? "TEST RUN — records created by this run are test data and are excluded from client-facing views."
          : "",
    },
  };
};

/** `dom.hash_message` — the artifact hash an approval binds to. */
const hashMessage: NodeHandler = async (ctx): Promise<NodeResult> => {
  const subject = await resolveString(ctx, String(ctx.config.subjectPath ?? ""));
  const body = await resolveString(ctx, String(ctx.config.bodyPath ?? ""));
  return {
    outcome: "succeeded",
    output: { bodyHash: hashBody(subject, body), subject, body },
  };
};

export const domainNodes: Record<string, NodeHandler> = {
  "dom.prepare_audit_refresh": prepareAuditRefresh,
  "dom.build_evidence_packet": buildPacket,
  "dom.build_prospect_evidence": buildProspectEvidence,
  "dom.start_outreach_sequence": startSequence,
  "dom.draft_outreach_message": draftMessage,
  "dom.record_outreach_sent": recordSent,
  "dom.apply_reply_signal": applyReply,
  "dom.suppress_recipient": suppressRecipient,
  "dom.check_suppression": checkSuppressed,
  "dom.find_sequence": findSequence,
  "dom.record_meeting_brief": recordMeetingBrief,
  "dom.record_meeting_decisions": recordDecisions,
  "dom.record_support_request": recordSupportRequest,
  "dom.compute_invoice_amount": computeInvoiceAmount,
  "dom.record_billing_event": recordBillingEvent,
  "dom.publish_event": publishDomainEvent,
  "dom.record_action_outcome": recordActionOutcome,
  "dom.assemble_report_section": assembleReportSection,
  "dom.disclose_test_mode": discloseTestMode,
  "dom.hash_message": hashMessage,
};
