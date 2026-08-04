/**
 * The context-packet builder (spec 022).
 *
 * Replaces "hand the agent every approved claim" with "hand the agent what this
 * task needs, inside a token budget, with instructions separated from facts,
 * every omission recorded, and every inclusion explainable".
 *
 * Three invariants, each enforced in code rather than by prompt:
 *
 *  1. **The never-truncate set is never truncated.** Privacy restrictions,
 *     material claim qualifiers, high-severity contradictions and approval
 *     requirements survive any budget. If they do not fit, the build fails.
 *     A packet missing a restriction looks complete, which is worse than none.
 *  2. **Every exclusion is recorded.** Anything dropped becomes a
 *     `context_packet_items` row with `included = false` and a reason. There is
 *     no silent path — "why is that fact missing?" always has a stored answer.
 *  3. **Nothing crosses a client boundary.** Every query is scoped by
 *     `project_id`, and validation re-checks the assembled packet before it is
 *     handed over.
 */
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { ClassifiedError } from "@/lib/errors";
import { publishEvent } from "@/lib/events/bus";
import { log } from "@/lib/logger";
import {
  CONTEXT_BUILDER_VERSION,
  FRESHNESS_SEVERITY,
  NEVER_TRUNCATE_PRIORITY_MAX,
  PACKET_PRIORITY,
  PACKET_RESERVED_SHARE,
  PACKET_TTL_HOURS,
  type FreshnessState,
} from "@/lib/knowledge/constants";
import { assessFreshness } from "@/lib/knowledge/freshness";
import { resolveInstructions, type ResolvedInstruction } from "@/lib/knowledge/instructions/service";
import { readActivePage } from "@/lib/knowledge/compiler/compile";
import { estimateTokens, truncateToTokens } from "@/lib/knowledge/context/tokens";
import {
  GENERIC_TEMPLATE,
  getPacketTemplate,
  type PacketTemplate,
} from "@/lib/knowledge/context/templates";
import { PRIVACY_ORDER, type PrivacyStatus } from "@/lib/knowledge/privacy";

// ------------------------------------------------------------------- types

export interface ContextPacketRequest {
  projectId: string;
  templateKey: string;
  taskObjective: string;
  agentKey?: string;
  workflowKey?: string;
  workflowRunId?: string | null;
  nodeRunId?: string | null;
  /** Restrict claims to these entities. */
  targetEntityIds?: string[];
  /** Extra claim categories beyond the template's required set. */
  additionalCategories?: string[];
  claimKeys?: string[];
  tokenBudget?: number;
  /** Free-text task input carried verbatim (a draft, a response, a brief). */
  taskInput?: string;
  /** Durable workflow state, so the agent does not depend on chat history. */
  workflowState?: Record<string, unknown>;
  now?: Date;
}

export interface PacketItem {
  itemType:
    | "hot_file"
    | "wiki_section"
    | "claim"
    | "evidence"
    | "instruction"
    | "contradiction"
    | "workflow_state"
    | "task_input"
    | "methodology";
  itemRef: string;
  label: string;
  body: string;
  priorityClass: number;
  selectionReason: string;
  retrievalScore: number | null;
  tokenCost: number;
  freshnessStatus: FreshnessState | null;
  privacyStatus: string | null;
  included: boolean;
  exclusionReason: string | null;
}

export interface MissingContext {
  kind: string;
  detail: string;
}

export interface ContextPacket {
  id: string | null;
  projectId: string;
  templateKey: string;
  agentKey: string | null;
  taskObjective: string;
  audience: string;
  items: PacketItem[];
  missingContext: MissingContext[];
  withheldClaimIds: string[];
  requiredDisclaimers: string[];
  tokenCount: number;
  tokenBudget: number;
  freshness: FreshnessState;
  contentHash: string;
  expiresAt: string;
  builderVersion: string;
}

export interface ContextPacketValidationResult {
  valid: boolean;
  failures: string[];
  warnings: string[];
}

export interface ContextPacketExplanation {
  packetId: string;
  templateKey: string;
  tokenCount: number;
  tokenBudget: number;
  included: PacketItem[];
  excluded: PacketItem[];
  missingContext: MissingContext[];
  validation: ContextPacketValidationResult;
}

// ------------------------------------------------------------------- build

/**
 * Assemble a packet. Deterministic selection first — identity, required
 * claims, instructions, methodology — then optional retrieval for supporting
 * material, then the budget, then validation.
 */
export async function buildPacket(request: ContextPacketRequest): Promise<ContextPacket> {
  const template = getPacketTemplate(request.templateKey) ?? GENERIC_TEMPLATE;
  const now = request.now ?? new Date();
  const budget = request.tokenBudget ?? template.defaultTokenBudget;

  const [project] = await sql`select id, name from projects where id = ${request.projectId}`;
  if (!project) throw new ClassifiedError("not_found", "Client not found.");

  const items: PacketItem[] = [];
  const missing: MissingContext[] = [];

  // 1 — the task objective. Always first, never truncated.
  items.push({
    itemType: "task_input",
    itemRef: "objective",
    label: "Task objective",
    body: request.taskObjective,
    priorityClass: PACKET_PRIORITY.taskObjective,
    selectionReason: "deterministic: the task objective is always included",
    retrievalScore: null,
    tokenCost: estimateTokens(request.taskObjective),
    freshnessStatus: null,
    privacyStatus: null,
    included: true,
    exclusionReason: null,
  });

  // 2 — instructions, carried separately from facts and labelled as rules.
  const { instructions, excluded: excludedInstructions } = await resolveInstructions({
    projectId: request.projectId,
    workflowKey: request.workflowKey ?? null,
    agentKey: request.agentKey ?? null,
    at: now,
  });
  for (const entry of excludedInstructions) {
    missing.push({
      kind: "instruction_excluded",
      detail: `"${entry.title}" was not applied: ${entry.reason}`,
    });
  }
  for (const instruction of instructions) {
    items.push(instructionItem(instruction));
  }
  for (const required of template.requiredInstructionTypes) {
    if (!instructions.some((i) => i.instructionType === required)) {
      // Disclosed rather than assumed: an agent told nothing about brand voice
      // will invent one.
      missing.push({
        kind: "missing_instruction",
        detail: `This task requires a ${required.replace(/_/g, " ")} instruction and none is active.`,
      });
    }
  }

  // 3 — claims, deterministically selected and privacy filtered.
  const categories = [...new Set([...template.requiredCategories, ...(request.additionalCategories ?? [])])];
  const { claims, withheld, freshnessExcluded } = await selectClaims({
    projectId: request.projectId,
    template,
    categories,
    claimKeys: request.claimKeys,
    targetEntityIds: request.targetEntityIds,
    now,
  });
  for (const entry of freshnessExcluded) {
    missing.push({ kind: "stale_claim_excluded", detail: entry });
  }
  for (const claim of claims) {
    items.push(claimItem(claim));
  }

  // 4 — evidence behind the selected claims.
  const evidenceIds = [...new Set(claims.flatMap((c) => c.evidenceIds))];
  if (evidenceIds.length > 0) {
    const rows = await sql`
      select id, kind, note, url, created_at from evidence where id = any(${evidenceIds})
    `;
    for (const row of rows) {
      const ageDays = Math.floor(
        (now.getTime() - (row.createdAt as Date).getTime()) / 86_400_000
      );
      const body = `[${row.id}] ${row.note}${row.url ? ` (${row.url})` : ""} — ${ageDays}d old`;
      items.push({
        itemType: "evidence",
        itemRef: row.id as string,
        label: row.kind as string,
        body,
        priorityClass: PACKET_PRIORITY.requiredEvidence,
        selectionReason: "deterministic: evidence cited by a selected claim",
        retrievalScore: null,
        tokenCost: estimateTokens(body),
        freshnessStatus: null,
        privacyStatus: null,
        included: true,
        exclusionReason: null,
      });
    }
  }

  // 5 — contradictions touching a selected claim. High severity never drops.
  const claimIds = claims.map((c) => c.id);
  if (claimIds.length > 0) {
    const rows = await sql`
      select id, claim_id, severity, description from claim_contradictions
      where project_id = ${request.projectId} and status = 'open'
        and (claim_id = any(${claimIds}) or contradicting_claim_id = any(${claimIds}))
    `;
    for (const row of rows) {
      const body = `[${row.severity}] ${row.description}`;
      items.push({
        itemType: "contradiction",
        itemRef: row.id as string,
        label: `contradiction on claim ${row.claimId}`,
        body,
        priorityClass: PACKET_PRIORITY.contradiction,
        selectionReason:
          "deterministic: an open contradiction touches a claim in this packet",
        retrievalScore: null,
        tokenCost: estimateTokens(body),
        freshnessStatus: null,
        privacyStatus: null,
        included: true,
        exclusionReason: null,
      });
    }
  }

  // 6 — durable workflow state, so the agent does not rely on chat history.
  if (request.workflowState && Object.keys(request.workflowState).length > 0) {
    const body = JSON.stringify(request.workflowState, null, 2);
    items.push({
      itemType: "workflow_state",
      itemRef: request.workflowRunId ?? "state",
      label: "Workflow state",
      body,
      priorityClass: PACKET_PRIORITY.workflowState,
      selectionReason: "deterministic: durable state for this workflow run",
      retrievalScore: null,
      tokenCost: estimateTokens(body),
      freshnessStatus: null,
      privacyStatus: null,
      included: true,
      exclusionReason: null,
    });
  }

  // 7 — compiled hot files. Cheaper and more consistent than re-deriving.
  for (const slug of template.hotFiles) {
    const page = await readActivePage({ projectId: request.projectId, slug });
    if (!page) {
      missing.push({
        kind: "hot_file_missing",
        detail: `The "${slug}" hot file has never been compiled for this client.`,
      });
      continue;
    }
    if (!allowedPrivacy(template, page.privacy as PrivacyStatus)) {
      missing.push({
        kind: "hot_file_withheld",
        detail: `"${slug}" is classified ${page.privacy} and this task's audience may not see it.`,
      });
      continue;
    }
    items.push({
      itemType: "hot_file",
      itemRef: page.pageId,
      label: slug,
      body: page.body,
      priorityClass: PACKET_PRIORITY.strategy,
      selectionReason: `deterministic: the ${template.key} template always includes the "${slug}" hot file`,
      retrievalScore: null,
      tokenCost: page.tokenCount,
      freshnessStatus: page.freshness,
      privacyStatus: page.privacy,
      included: true,
      exclusionReason: null,
    });
    if (page.stale) {
      missing.push({
        kind: "stale_hot_file",
        detail: `"${slug}" is marked stale and may not reflect the latest approved knowledge.`,
      });
    }
  }

  // 8 — retrieval for supporting material, when the template allows it.
  if (template.allowsRetrieval) {
    const supporting = await retrieveSupporting({
      projectId: request.projectId,
      objective: request.taskObjective,
      excludeClaimIds: new Set(claimIds),
      template,
      now,
    });
    items.push(...supporting);
  }

  if (template.requiresClaims && claims.length === 0) {
    // Not an error here — the caller decides whether to safe-stop — but the
    // packet says so loudly rather than looking merely thin.
    missing.push({
      kind: "no_approved_claims",
      detail:
        "No approved claims are available for this task. An agent must not state any client fact.",
    });
  }

  const budgeted = applyTokenBudget(items, budget);
  const disclaimers = buildDisclaimers(claims, items, missing);
  const freshness = worstOf(claims.map((c) => c.freshness));

  const content = {
    templateKey: template.key,
    version: template.version,
    audience: template.audience,
    objective: request.taskObjective,
    items: budgeted.items
      .filter((i) => i.included)
      .map((i) => ({ type: i.itemType, ref: i.itemRef, body: i.body })),
    missingContext: missing,
    disclaimers,
  };
  const contentHash = createHash("sha256").update(JSON.stringify(content)).digest("hex");
  const expiresAt = new Date(now.getTime() + PACKET_TTL_HOURS * 3_600_000).toISOString();

  return {
    id: null,
    projectId: request.projectId,
    templateKey: template.key,
    agentKey: request.agentKey ?? null,
    taskObjective: request.taskObjective,
    audience: template.audience,
    items: budgeted.items,
    missingContext: missing,
    withheldClaimIds: withheld,
    requiredDisclaimers: disclaimers,
    tokenCount: budgeted.tokenCount,
    tokenBudget: budget,
    freshness,
    contentHash,
    expiresAt,
    builderVersion: CONTEXT_BUILDER_VERSION,
  };
}

// -------------------------------------------------------------- selection

export interface SelectedClaim {
  id: string;
  key: string;
  text: string;
  value: unknown;
  predicate: string | null;
  category: string;
  materiality: string;
  privacyStatus: PrivacyStatus;
  verificationStatus: string;
  confidence: number | null;
  asOf: string | null;
  effectiveDate: string | null;
  reviewDate: string | null;
  allowedWording: string[];
  prohibitedWording: string[];
  evidenceIds: string[];
  freshness: FreshnessState;
  freshnessReason: string;
}

/**
 * The single claim-selection implementation. `lib/knowledge/packet.ts` delegates
 * here rather than running its own query, so privacy filtering, freshness
 * exclusion and category rules have exactly one definition in this codebase.
 */
export async function selectClaims(args: {
  projectId: string;
  template: PacketTemplate;
  categories: string[];
  claimKeys?: string[];
  targetEntityIds?: string[];
  now: Date;
}): Promise<{ claims: SelectedClaim[]; withheld: string[]; freshnessExcluded: string[] }> {
  const rows = await sql`
    select id, key, canonical_text, value, normalized_predicate, category,
      materiality, status, privacy_status, verification_status, confidence,
      allowed_wording, prohibited_wording, evidence_ids, subject_entity_id,
      to_char(as_of, 'YYYY-MM-DD') as as_of,
      to_char(effective_date, 'YYYY-MM-DD') as effective_date,
      to_char(review_date, 'YYYY-MM-DD') as review_date,
      last_verified_at
    from claims
    where project_id = ${args.projectId} and status = 'approved'
      ${args.categories.length > 0 ? sql`and category = any(${args.categories})` : sql``}
      ${args.claimKeys?.length ? sql`and key = any(${args.claimKeys})` : sql``}
      ${args.targetEntityIds?.length ? sql`and subject_entity_id = any(${args.targetEntityIds})` : sql``}
    order by key asc
  `;

  const claims: SelectedClaim[] = [];
  const withheld: string[] = [];
  const freshnessExcluded: string[] = [];
  const floor = FRESHNESS_SEVERITY[args.template.minFreshness];

  for (const row of rows) {
    const category = (row.category as string) ?? "general";
    if (args.template.excludedCategories.includes(category)) {
      withheld.push(row.id as string);
      continue;
    }
    const privacy = (row.privacyStatus as PrivacyStatus) ?? "public";
    if (!allowedPrivacy(args.template, privacy)) {
      // Recorded, never silently dropped: the omission is auditable.
      withheld.push(row.id as string);
      continue;
    }
    const freshness = assessFreshness(
      {
        category,
        status: row.status as string,
        asOf: (row.asOf as string | null) ?? null,
        effectiveDate: (row.effectiveDate as string | null) ?? null,
        reviewDate: (row.reviewDate as string | null) ?? null,
        lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null,
        verificationStatus: (row.verificationStatus as string | null) ?? null,
      },
      args.now
    );
    if (FRESHNESS_SEVERITY[freshness.state] > floor) {
      freshnessExcluded.push(
        `"${row.key as string}" was excluded (${freshness.state}): ${freshness.reason}`
      );
      continue;
    }
    claims.push({
      id: row.id as string,
      key: row.key as string,
      text: row.canonicalText as string,
      value: row.value ?? null,
      predicate: (row.normalizedPredicate as string | null) ?? null,
      category,
      materiality: (row.materiality as string) ?? "ordinary",
      privacyStatus: privacy,
      verificationStatus: (row.verificationStatus as string) ?? "unverified",
      confidence: row.confidence === null ? null : Number(row.confidence),
      asOf: (row.asOf as string | null) ?? null,
      effectiveDate: (row.effectiveDate as string | null) ?? null,
      reviewDate: (row.reviewDate as string | null) ?? null,
      allowedWording: (row.allowedWording as string[]) ?? [],
      prohibitedWording: (row.prohibitedWording as string[]) ?? [],
      evidenceIds: (row.evidenceIds as string[]) ?? [],
      freshness: freshness.state,
      freshnessReason: freshness.reason,
    });
  }
  return { claims, withheld, freshnessExcluded };
}

/**
 * Lexical + structural retrieval for supporting material. Deliberately not a
 * vector search: the rules that govern what an agent may *say* are structural,
 * and this only ranks what it may find useful. See
 * docs/architecture/knowledge-compilation-and-context-engineering.md.
 */
async function retrieveSupporting(args: {
  projectId: string;
  objective: string;
  excludeClaimIds: Set<string>;
  template: PacketTemplate;
  now: Date;
}): Promise<PacketItem[]> {
  const terms = args.objective
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 3);
  if (terms.length === 0) return [];

  const query = terms.join(" | ");
  const rows = await sql`
    select id, key, canonical_text, category, privacy_status, materiality,
      to_char(as_of, 'YYYY-MM-DD') as as_of,
      to_char(review_date, 'YYYY-MM-DD') as review_date,
      verification_status, last_verified_at, status,
      ts_rank(to_tsvector('english', canonical_text),
        to_tsquery('english', ${query})) as rank
    from claims
    where project_id = ${args.projectId} and status = 'approved'
      and to_tsvector('english', canonical_text) @@ to_tsquery('english', ${query})
      ${args.template.excludedCategories.length > 0
        ? sql`and category <> all(${args.template.excludedCategories})`
        : sql``}
    order by rank desc
    limit 10
  `;

  const items: PacketItem[] = [];
  for (const row of rows) {
    if (args.excludeClaimIds.has(row.id as string)) continue;
    const privacy = (row.privacyStatus as PrivacyStatus) ?? "public";
    if (!allowedPrivacy(args.template, privacy)) continue;
    const freshness = assessFreshness(
      {
        category: (row.category as string) ?? "general",
        status: row.status as string,
        asOf: (row.asOf as string | null) ?? null,
        reviewDate: (row.reviewDate as string | null) ?? null,
        lastVerifiedAt: (row.lastVerifiedAt as Date | null) ?? null,
        verificationStatus: (row.verificationStatus as string | null) ?? null,
      },
      args.now
    );
    if (FRESHNESS_SEVERITY[freshness.state] > FRESHNESS_SEVERITY[args.template.minFreshness]) {
      continue;
    }
    const body = `[claim:${row.id}] ${row.canonicalText}`;
    items.push({
      itemType: "claim",
      itemRef: row.id as string,
      label: row.key as string,
      body,
      // Retrieved material is supporting context, so it sits below everything
      // the task actually requires and is dropped first under pressure.
      priorityClass: PACKET_PRIORITY.historical,
      selectionReason: `retrieval: full-text match on the task objective (rank ${Number(row.rank).toFixed(3)})`,
      retrievalScore: Number(row.rank),
      tokenCost: estimateTokens(body),
      freshnessStatus: freshness.state,
      privacyStatus: privacy,
      included: true,
      exclusionReason: null,
    });
  }
  return items;
}

// ---------------------------------------------------------------- budgeting

/**
 * Fit the packet to its budget.
 *
 * Priority classes 1-5 are the never-truncate set. If they alone exceed the
 * budget, this throws — a packet that dropped a privacy restriction to fit
 * would look complete while being unsafe.
 */
export function applyTokenBudget(
  items: PacketItem[],
  budget: number
): { items: PacketItem[]; tokenCount: number } {
  const ordered = [...items].sort(
    (a, b) => a.priorityClass - b.priorityClass || b.tokenCost - a.tokenCost
  );
  const mandatory = ordered.filter((i) => i.priorityClass <= NEVER_TRUNCATE_PRIORITY_MAX);
  const optional = ordered.filter((i) => i.priorityClass > NEVER_TRUNCATE_PRIORITY_MAX);

  const mandatoryTokens = mandatory.reduce((sum, i) => sum + i.tokenCost, 0);
  if (mandatoryTokens > budget) {
    throw new ClassifiedError(
      "validation",
      `The required context for this task is ${mandatoryTokens} tokens and the budget is ${budget}. ` +
        "Raise the budget or narrow the task — dropping a privacy restriction or a material qualifier to fit is not an option."
    );
  }

  const result: PacketItem[] = [...mandatory];
  let used = mandatoryTokens;

  // Priority classes 2-4 (safety instructions, approved claims, required
  // evidence) carry reserved shares in the spec. They are admitted in FULL
  // above, which is strictly stronger than a floor, so their reservations need
  // no further arithmetic here.
  //
  // Workflow state is the one reserved class that is optional, and it is the
  // one a large hot file would otherwise crowd out — a packet that drops the
  // run's own state forces the agent back onto conversation history, which is
  // exactly what this layer exists to stop. So it gets its floor first.
  const stateFloor = Math.floor(budget * (PACKET_RESERVED_SHARE.workflowState ?? 0));
  const reservedFirst = optional.filter(
    (i) => i.priorityClass === PACKET_PRIORITY.workflowState && i.tokenCost <= stateFloor
  );
  for (const item of reservedFirst) {
    result.push(item);
    used += item.tokenCost;
  }
  const admitted = new Set(reservedFirst);

  for (const item of optional) {
    if (admitted.has(item)) continue;
    if (used + item.tokenCost <= budget) {
      result.push(item);
      used += item.tokenCost;
      continue;
    }
    const remaining = budget - used;
    // Compact rather than drop when a meaningful amount still fits: half a hot
    // file beats none, and the truncation is disclosed on the item.
    if (remaining > 200 && item.itemType === "hot_file") {
      const cut = truncateToTokens(item.body, remaining);
      result.push({
        ...item,
        body: `${cut.text}\n\n_[compacted to fit the token budget; ${cut.droppedTokens} tokens omitted — see the full page in the wiki]_`,
        tokenCost: remaining,
        exclusionReason: `compacted: ${cut.droppedTokens} tokens omitted to fit the budget`,
      });
      used = budget;
      continue;
    }
    result.push({
      ...item,
      included: false,
      exclusionReason: `dropped: ${item.tokenCost} tokens did not fit in the remaining ${remaining}`,
    });
  }

  return { items: result, tokenCount: used };
}

// -------------------------------------------------------------- persistence

/** Store the packet and its items. The packet row is immutable once written. */
export async function recordContextPacket(
  packet: ContextPacket,
  refs: { workflowRunId?: string | null; nodeRunId?: string | null; userId?: string | null }
): Promise<string> {
  const claimIds = packet.items
    .filter((i) => i.itemType === "claim" && i.included)
    .map((i) => i.itemRef);
  const evidenceIds = packet.items
    .filter((i) => i.itemType === "evidence" && i.included)
    .map((i) => i.itemRef);

  return sql.begin(async (tx) => {
    const [row] = await tx`
      insert into evidence_packets (
        project_id, workflow_run_id, node_run_id, purpose, claim_ids, evidence_ids,
        withheld_claim_ids, contradictions, required_disclaimers, content,
        content_hash, template_key, agent_key, task_objective, audience,
        token_count, token_budget, freshness_floor, validation, missing_context,
        expires_at
      ) values (
        ${packet.projectId}, ${refs.workflowRunId ?? null}, ${refs.nodeRunId ?? null},
        ${packet.taskObjective.slice(0, 200)}, ${claimIds}, ${evidenceIds},
        ${packet.withheldClaimIds},
        ${tx.json(
          packet.items
            .filter((i) => i.itemType === "contradiction")
            .map((i) => ({ ref: i.itemRef, body: i.body })) as never
        )},
        ${packet.requiredDisclaimers},
        ${tx.json({ builderVersion: packet.builderVersion, freshness: packet.freshness } as never)},
        ${packet.contentHash}, ${packet.templateKey}, ${packet.agentKey},
        ${packet.taskObjective}, ${packet.audience}, ${packet.tokenCount},
        ${packet.tokenBudget}, ${packet.freshness},
        ${tx.json({} as never)}, ${tx.json(packet.missingContext as never)},
        ${packet.expiresAt}
      )
      returning id
    `;
    const packetId = row!.id as string;

    for (const [index, item] of packet.items.entries()) {
      await tx`
        insert into context_packet_items (
          packet_id, item_type, item_ref, label, priority_class, selection_reason,
          retrieval_score, token_cost, freshness_status, privacy_status,
          included, exclusion_reason, position
        ) values (
          ${packetId}, ${item.itemType}, ${item.itemRef}, ${item.label},
          ${item.priorityClass}, ${item.selectionReason}, ${item.retrievalScore},
          ${item.tokenCost}, ${item.freshnessStatus}, ${item.privacyStatus},
          ${item.included}, ${item.exclusionReason}, ${index}
        )
      `;
    }

    // Access is audited through the one audit system, not a second table.
    await writeAudit(tx, {
      userId: refs.userId ?? null,
      action: "knowledge.packet.build",
      entity: "context_packet",
      entityId: packetId,
      detail: {
        templateKey: packet.templateKey,
        agentKey: packet.agentKey,
        tokenCount: packet.tokenCount,
        claims: claimIds.length,
        withheld: packet.withheldClaimIds.length,
      },
    });
    await publishEvent(tx, {
      type: "context.packet_created",
      projectId: packet.projectId,
      payload: {
        packetId,
        templateKey: packet.templateKey,
        agentKey: packet.agentKey ?? "",
        tokenCount: packet.tokenCount,
      },
    });
    return packetId;
  });
}

// -------------------------------------------------------------- validation

/**
 * Validate before the packet reaches an agent. A failure is a classified
 * error at the call site — never a packet with a warning attached.
 */
export async function validatePacket(
  packet: ContextPacket
): Promise<ContextPacketValidationResult> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const template = getPacketTemplate(packet.templateKey) ?? GENERIC_TEMPLATE;

  const included = packet.items.filter((i) => i.included);

  // A `restricted` claim exists so a human knows about it, never so a model
  // can use it. This check is belt-and-braces over the selection filter.
  for (const item of included) {
    if (item.privacyStatus === "restricted") {
      failures.push(`Item ${item.itemRef} is classified restricted and must never enter a packet.`);
    }
    if (item.privacyStatus && !allowedPrivacy(template, item.privacyStatus as PrivacyStatus)) {
      failures.push(
        `Item ${item.itemRef} is ${item.privacyStatus}; the ${template.audience} audience may not see it.`
      );
    }
  }

  // Cross-client leakage: verify every referenced claim really belongs here.
  const claimIds = included.filter((i) => i.itemType === "claim").map((i) => i.itemRef);
  if (claimIds.length > 0) {
    const rows = await sql`
      select id from claims where id = any(${claimIds}) and project_id = ${packet.projectId}
    `;
    const owned = new Set(rows.map((r) => r.id as string));
    for (const id of claimIds) {
      if (!owned.has(id)) {
        failures.push(`Claim ${id} does not belong to this client.`);
      }
    }
  }

  if (packet.tokenCount > packet.tokenBudget) {
    failures.push(
      `The packet is ${packet.tokenCount} tokens against a budget of ${packet.tokenBudget}.`
    );
  }

  for (const required of template.requiredInstructionTypes) {
    const present = included.some(
      (i) => i.itemType === "instruction" && i.label === required
    );
    if (!present) {
      // A warning, not a failure: the missing-context list already discloses
      // it, and refusing to run every task until the operator writes a brand
      // voice document would make the layer unusable.
      warnings.push(`No ${required.replace(/_/g, " ")} instruction is active for this task.`);
    }
  }

  if (template.requiresClaims && claimIds.length === 0) {
    failures.push(
      "This task requires approved claims and none are available; drafting would mean inventing facts."
    );
  }

  const highSeverityDropped = packet.items.some(
    (i) => !i.included && i.itemType === "contradiction"
  );
  if (highSeverityDropped) {
    failures.push("A contradiction was dropped from the packet; contradictions are never optional.");
  }

  return { valid: failures.length === 0, failures, warnings };
}

/**
 * Build, validate and store in one call. Throws rather than returning an
 * invalid packet — the whole point is that an agent cannot receive one.
 */
export async function buildValidatedPacket(
  request: ContextPacketRequest,
  refs: { workflowRunId?: string | null; nodeRunId?: string | null; userId?: string | null } = {}
): Promise<{ packet: ContextPacket; packetId: string }> {
  const packet = await buildPacket(request);
  const validation = await validatePacket(packet);

  if (!validation.valid) {
    await sql.begin((tx) =>
      publishEvent(tx, {
        type: "context.packet_rejected",
        projectId: request.projectId,
        payload: {
          templateKey: packet.templateKey,
          agentKey: packet.agentKey ?? "",
          reason: validation.failures.join("; "),
        },
      })
    );
    log("warn", "knowledge.packet.rejected", {
      templateKey: packet.templateKey,
      failures: validation.failures,
    });
    throw new ClassifiedError(
      "validation",
      `The context packet failed validation and was not handed to an agent: ${validation.failures.join("; ")}`
    );
  }

  const packetId = await recordContextPacket(packet, refs);
  return { packet: { ...packet, id: packetId }, packetId };
}

// ------------------------------------------------------------- explanation

/** Everything the packet inspector shows: what, why, and what was left out. */
export async function explainPacket(packetId: string): Promise<ContextPacketExplanation> {
  const [packet] = await sql`
    select id, project_id, template_key, token_count, token_budget, missing_context
    from evidence_packets where id = ${packetId}
  `;
  if (!packet) throw new ClassifiedError("not_found", "Context packet not found.");

  const rows = await sql`
    select item_type, item_ref, label, priority_class, selection_reason,
      retrieval_score, token_cost, freshness_status, privacy_status,
      included, exclusion_reason
    from context_packet_items
    where packet_id = ${packetId}
    order by position asc
  `;
  const items: PacketItem[] = rows.map((row) => ({
    itemType: row.itemType as PacketItem["itemType"],
    itemRef: row.itemRef as string,
    label: row.label as string,
    body: "",
    priorityClass: row.priorityClass as number,
    selectionReason: row.selectionReason as string,
    retrievalScore: row.retrievalScore === null ? null : Number(row.retrievalScore),
    tokenCost: row.tokenCost as number,
    freshnessStatus: (row.freshnessStatus as FreshnessState | null) ?? null,
    privacyStatus: (row.privacyStatus as string | null) ?? null,
    included: Boolean(row.included),
    exclusionReason: (row.exclusionReason as string | null) ?? null,
  }));

  return {
    packetId,
    templateKey: (packet.templateKey as string) ?? "generic",
    tokenCount: packet.tokenCount as number,
    tokenBudget: (packet.tokenBudget as number) ?? 0,
    included: items.filter((i) => i.included),
    excluded: items.filter((i) => !i.included),
    missingContext: (packet.missingContext as MissingContext[]) ?? [],
    validation: { valid: true, failures: [], warnings: [] },
  };
}

// ---------------------------------------------------------------- rendering

/**
 * Render the packet as the text an agent actually sees. Facts and instructions
 * are in separate, labelled blocks — an agent that cannot tell a rule from a
 * fact will restate the rule as a fact.
 */
export function renderContextPacket(packet: ContextPacket): string {
  const included = packet.items.filter((i) => i.included);
  const sections: string[] = [];

  const objective = included.find((i) => i.itemType === "task_input");
  if (objective) sections.push(`# Task\n${objective.body}`);

  const instructions = included.filter((i) => i.itemType === "instruction");
  if (instructions.length > 0) {
    sections.push(
      "# Operating instructions (rules, not facts — follow them; never restate them as client facts)\n" +
        instructions.map((i) => `- ${i.body}`).join("\n")
    );
  }

  const claims = included.filter((i) => i.itemType === "claim");
  sections.push(
    claims.length > 0
      ? `# Approved client facts (the ONLY facts you may state)\n${claims.map((i) => `- ${i.body}`).join("\n")}`
      : "# Approved client facts\n(none — you must not state any client fact in this task)"
  );

  const contradictions = included.filter((i) => i.itemType === "contradiction");
  if (contradictions.length > 0) {
    sections.push(
      `# Unresolved contradictions — do not assert these points\n${contradictions.map((i) => `- ${i.body}`).join("\n")}`
    );
  }

  const hotFiles = included.filter((i) => i.itemType === "hot_file");
  for (const file of hotFiles) {
    sections.push(`# Compiled knowledge: ${file.label}\n${file.body}`);
  }

  const evidence = included.filter((i) => i.itemType === "evidence");
  if (evidence.length > 0) {
    sections.push(`# Sources\n${evidence.map((i) => `- ${i.body}`).join("\n")}`);
  }

  const state = included.find((i) => i.itemType === "workflow_state");
  if (state) sections.push(`# Workflow state\n${state.body}`);

  if (packet.missingContext.length > 0) {
    // Disclosed to the agent, not merely logged: an agent that knows a fact is
    // missing can say so; one that does not will fill the gap.
    sections.push(
      `# Known gaps in this context\n${packet.missingContext.map((m) => `- ${m.detail}`).join("\n")}`
    );
  }
  if (packet.requiredDisclaimers.length > 0) {
    sections.push(
      `# Required disclaimers\n${packet.requiredDisclaimers.map((d) => `- ${d}`).join("\n")}`
    );
  }

  return sections.join("\n\n");
}

// ------------------------------------------------------------------ helpers

const AUDIENCE_MAX_PRIVACY: Record<string, PrivacyStatus[]> = {
  public: ["public"],
  client: ["public", "client_only"],
  internal: ["public", "client_only", "internal"],
};

function allowedPrivacy(template: PacketTemplate, privacy: PrivacyStatus): boolean {
  if (privacy === "restricted") return false;
  const byAudience = AUDIENCE_MAX_PRIVACY[template.audience] ?? ["public"];
  return byAudience.includes(privacy) && template.allowedPrivacy.includes(privacy);
}

function instructionItem(instruction: ResolvedInstruction): PacketItem {
  const body = `[${instruction.isSafety ? "MUST" : "SHOULD"}] ${instruction.title}: ${instruction.body}`;
  return {
    itemType: "instruction",
    itemRef: instruction.versionId,
    label: instruction.instructionType,
    body,
    // Safety instructions are never truncated; ordinary ones sit with claims.
    priorityClass: instruction.isSafety
      ? PACKET_PRIORITY.safetyInstruction
      : PACKET_PRIORITY.approvedClaim,
    selectionReason: `deterministic: active ${instruction.scope}-scoped ${instruction.instructionType} instruction`,
    retrievalScore: null,
    tokenCost: estimateTokens(body),
    freshnessStatus: null,
    privacyStatus: null,
    included: true,
    exclusionReason: null,
  };
}

function claimItem(claim: SelectedClaim): PacketItem {
  const meta: string[] = [];
  if (claim.asOf) meta.push(`as of ${claim.asOf}`);
  if (claim.freshness !== "current") meta.push(`freshness: ${claim.freshness}`);
  if (claim.verificationStatus !== "verified") {
    meta.push(`verification: ${claim.verificationStatus}`);
  }
  if (claim.allowedWording.length > 0) {
    meta.push(`use wording: ${claim.allowedWording.join(" | ")}`);
  }
  if (claim.prohibitedWording.length > 0) {
    meta.push(`never say: ${claim.prohibitedWording.join(" | ")}`);
  }
  const body = `[claim:${claim.id}] ${claim.text}${meta.length > 0 ? ` (${meta.join("; ")})` : ""}`;
  return {
    itemType: "claim",
    itemRef: claim.id,
    label: claim.key,
    body,
    priorityClass: PACKET_PRIORITY.approvedClaim,
    selectionReason: `deterministic: approved ${claim.category.replace(/_/g, " ")} claim required by this template`,
    retrievalScore: null,
    tokenCost: estimateTokens(body),
    freshnessStatus: claim.freshness,
    privacyStatus: claim.privacyStatus,
    included: true,
    exclusionReason: null,
  };
}

function buildDisclaimers(
  claims: SelectedClaim[],
  items: PacketItem[],
  missing: MissingContext[]
): string[] {
  const disclaimers: string[] = [];
  if (claims.some((c) => c.freshness !== "current")) {
    disclaimers.push(
      "One or more claims are outside their review window and are stated as of their recorded date, not as current fact."
    );
  }
  if (items.some((i) => i.itemType === "contradiction" && i.included)) {
    disclaimers.push(
      "An unresolved contradiction exists in the supporting facts; do not assert the disputed point."
    );
  }
  if (claims.length === 0) {
    disclaimers.push("No approved client facts were available for this task. Do not invent any.");
  }
  if (missing.length > 0) {
    disclaimers.push(
      "This context has known gaps, listed above. Say so rather than filling them."
    );
  }
  return disclaimers;
}

function worstOf(states: FreshnessState[]): FreshnessState {
  if (states.length === 0) return "unknown";
  return states.reduce((worst, state) =>
    FRESHNESS_SEVERITY[state] > FRESHNESS_SEVERITY[worst] ? state : worst
  );
}

export { PRIVACY_ORDER };
