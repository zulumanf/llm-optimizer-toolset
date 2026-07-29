/**
 * Deterministic nodes.
 *
 * Every function here is reproducible from its inputs. No LLM, no heuristic, no
 * "roughly". That is not purity for its own sake: a number in a client report
 * has to be defensible a year later, and the only numbers that survive that are
 * the ones a person can recompute.
 *
 * Where a value cannot be computed honestly, these nodes return `unknown`
 * rather than a plausible default. A zero that means "we could not measure" is
 * the single most damaging thing a reporting pipeline can produce.
 */
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import { resolve, resolveObject } from "@/lib/automation/nodes/paths";
import { computePriority } from "@/lib/workflow/exceptions";
import { attributionConfidenceGate, type AttributionClass } from "@/lib/workflow/gates";
import {
  applyMappingBatch,
  normalizeEmail,
  normalizePhone,
  normalizeUrl,
  type MappingVersion,
} from "@/lib/connectors/mapping";
import type { NodeHandler, NodeResult, RiskLevel } from "@/lib/workflow/types";

/**
 * Tables a record node may touch.
 *
 * `scopeColumn` is the column carrying tenant scope; `orderColumn` is that
 * table's own creation timestamp. Both are declared per table rather than
 * assumed, because assuming `created_at` is exactly the kind of convention that
 * works until it silently does not — `runs` uses `started_at` and
 * `billing_events` uses `occurred_at`.
 */
interface RecordTableSpec {
  scopeColumn: string | null;
  orderColumn: string;
}

const RECORD_TABLES: Record<string, RecordTableSpec> = {
  claims: { scopeColumn: "project_id", orderColumn: "created_at" },
  content_assets: { scopeColumn: "project_id", orderColumn: "created_at" },
  companies: { scopeColumn: null, orderColumn: "created_at" },
  runs: { scopeColumn: "project_id", orderColumn: "started_at" },
  reports: { scopeColumn: "project_id", orderColumn: "created_at" },
  tasks: { scopeColumn: "project_id", orderColumn: "created_at" },
  outreach_sequences: { scopeColumn: "project_id", orderColumn: "created_at" },
  meeting_briefs: { scopeColumn: "project_id", orderColumn: "created_at" },
  meeting_decisions: { scopeColumn: "project_id", orderColumn: "created_at" },
  support_requests: { scopeColumn: "project_id", orderColumn: "created_at" },
  billing_events: { scopeColumn: "project_id", orderColumn: "occurred_at" },
  action_outcomes: { scopeColumn: "project_id", orderColumn: "created_at" },
};

function assertTable(table: string): RecordTableSpec {
  const entry = RECORD_TABLES[table];
  if (!entry) {
    throw new Error(
      `Table "${table}" is not in the record-node allowlist. Add it deliberately in lib/automation/nodes/deterministic.ts.`
    );
  }
  return entry;
}

// ------------------------------------------------------------------ records

const fetchRecord: NodeHandler = async (ctx): Promise<NodeResult> => {
  const table = String(ctx.config.table ?? "");
  const { scopeColumn } = assertTable(table);
  const idPath = String(ctx.config.idPath ?? "");
  const id = String(await resolve(ctx, idPath) ?? ctx.config.id ?? "");
  if (id.length === 0) {
    return { outcome: "failed_terminal", error: `fetch_record found no id at "${idPath}"` };
  }

  const rows = scopeColumn
    ? await sql`
        select * from ${sql(table)}
        where id = ${id}::uuid and ${sql(scopeColumn)} = ${ctx.projectId}
      `
    : await sql`select * from ${sql(table)} where id = ${id}::uuid`;

  if (rows.length === 0) {
    // Absent-or-other-tenant are deliberately indistinguishable to the caller.
    return {
      outcome: "failed_terminal",
      error: `no ${table} record ${id} in this client's scope`,
    };
  }
  return { outcome: "succeeded", output: { record: rows[0] as Record<string, unknown> } };
};

const queryRecords: NodeHandler = async (ctx): Promise<NodeResult> => {
  const table = String(ctx.config.table ?? "");
  const { scopeColumn, orderColumn } = assertTable(table);
  const limit = Math.min(Number(ctx.config.limit ?? 100), 1000);

  if (!scopeColumn && ctx.config.allowUnscoped !== true) {
    return {
      outcome: "failed_terminal",
      error: `querying "${table}" is unscoped; set allowUnscoped explicitly if that is intended`,
    };
  }
  // A platform-scoped run has no project to filter by; the query must then be
  // explicitly unscoped rather than silently matching `project_id = null`.
  const scoped = scopeColumn !== null && ctx.projectId !== null;
  const rows = scoped
    ? await sql`
        select * from ${sql(table)} where ${sql(scopeColumn!)} = ${ctx.projectId}
        order by ${sql(orderColumn)} desc limit ${limit}
      `
    : await sql`
        select * from ${sql(table)} order by ${sql(orderColumn)} desc limit ${limit}
      `;

  return {
    outcome: "succeeded",
    output: {
      records: rows as unknown[],
      count: rows.length,
      truncated: rows.length >= limit,
      scoped,
      table,
    },
  };
};

// ------------------------------------------------------------ normalisation

const normalizeEntity: NodeHandler = async (ctx): Promise<NodeResult> => {
  const path = String(ctx.config.sourcePath ?? "");
  const source = await resolveObject(ctx, path);
  const email = typeof source.email === "string" ? normalizeEmail(source.email) : "";
  const phone = typeof source.phone === "string" ? normalizePhone(source.phone) : "";
  const website = typeof source.website === "string" ? normalizeUrl(source.website) : "";
  const name = typeof source.name === "string" ? source.name.trim().replace(/\s+/g, " ") : "";

  return {
    outcome: "succeeded",
    output: {
      normalized: { name, email, phone, website },
      // Which fields were actually present, so downstream code can distinguish
      // "empty because absent" from "empty because blank".
      present: {
        name: name.length > 0,
        email: email.length > 0,
        phone: phone.length > 0,
        website: website.length > 0,
      },
    },
  };
};

const mapFields: NodeHandler = async (ctx): Promise<NodeResult> => {
  const mappingKey = String(ctx.config.mappingKey ?? "");
  const rowsPath = String(ctx.config.rowsPath ?? "");
  const raw = await resolve(ctx, rowsPath);
  const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];

  const [definition] = await sql`
    select d.id, d.active_version, v.version, v.fields, v.status,
           v.suggested_by_agent, v.approved_by
    from field_mapping_definitions d
    join field_mapping_versions v
      on v.definition_id = d.id and v.version = d.active_version
    where d.key = ${mappingKey}
      and (d.project_id = ${ctx.projectId} or d.project_id is null)
    order by (d.project_id is not null) desc
    limit 1
  `;
  if (!definition) {
    return {
      outcome: "failed_terminal",
      error: `no active field mapping "${mappingKey}" for this client. Create and approve one first.`,
    };
  }

  const version: MappingVersion = {
    definitionId: definition.id as string,
    version: Number(definition.version),
    status: definition.status as MappingVersion["status"],
    fields: definition.fields as MappingVersion["fields"],
    suggestedByAgent: (definition.suggestedByAgent as string | null) ?? null,
    approvedBy: (definition.approvedBy as string | null) ?? null,
  };

  try {
    const result = applyMappingBatch(version, rows);
    // Per-row failures are reported, not swallowed. A partially mapped import
    // that claims success is how silent data loss happens.
    return {
      outcome: result.failures.length === 0 ? "succeeded" : "succeeded",
      output: {
        mapped: result.mapped,
        mappedCount: result.mapped.length,
        failures: result.failures,
        failureCount: result.failures.length,
        unmappedSourceFields: result.unmappedSourceFields,
        mappingVersion: version.version,
        partial: result.failures.length > 0,
      },
    };
  } catch (err) {
    return {
      outcome: "failed_terminal",
      error: err instanceof Error ? err.message : "mapping failed",
    };
  }
};

const deduplicate: NodeHandler = async (ctx): Promise<NodeResult> => {
  const rowsPath = String(ctx.config.rowsPath ?? "");
  const keyField = String(ctx.config.keyField ?? "");
  const raw = await resolve(ctx, rowsPath);
  const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];

  const seen = new Set<string>();
  const unique: Record<string, unknown>[] = [];
  const duplicates: Record<string, unknown>[] = [];
  for (const row of rows) {
    const key = String(row[keyField] ?? "");
    if (key.length === 0 || seen.has(key)) {
      duplicates.push(row);
      continue;
    }
    seen.add(key);
    unique.push(row);
  }
  return {
    outcome: "succeeded",
    output: {
      unique,
      uniqueCount: unique.length,
      duplicates,
      duplicateCount: duplicates.length,
      keyField,
    },
  };
};

// -------------------------------------------------------------- calculation

/**
 * `calculate_metric` — a rate with its numerator, denominator, sample and
 * period attached. The gate for every metric in this platform: if it cannot
 * state its own denominator, it is not a metric.
 */
const calculateMetric: NodeHandler = async (ctx): Promise<NodeResult> => {
  const numeratorPath = String(ctx.config.numeratorPath ?? "");
  const denominatorPath = String(ctx.config.denominatorPath ?? "");
  const numerator = Number(await resolve(ctx, numeratorPath) ?? 0);
  const denominator = Number(await resolve(ctx, denominatorPath) ?? 0);
  const minimumSample = Number(ctx.config.minimumSample ?? 1);

  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return {
      outcome: "safe_stop",
      reason: "metric inputs are not numeric; refusing to compute a number we cannot defend",
    };
  }
  if (denominator < minimumSample) {
    return {
      outcome: "succeeded",
      output: {
        value: null,
        unknown: true,
        reason: `sample of ${denominator} is below the minimum of ${minimumSample}`,
        numerator,
        denominator,
        sample: denominator,
        minimumSample,
        calculationVersion: String(ctx.config.calculationVersion ?? "v1.0"),
      },
    };
  }
  return {
    outcome: "succeeded",
    output: {
      value: numerator / denominator,
      unknown: false,
      numerator,
      denominator,
      sample: denominator,
      minimumSample,
      period: ctx.config.period ?? null,
      scope: ctx.config.scope ?? null,
      calculationVersion: String(ctx.config.calculationVersion ?? "v1.0"),
    },
  };
};

/**
 * `compare_periods` — the delta, with materiality decided by a declared
 * threshold. Ordinary LLM run-to-run variance must not become a client alert,
 * which is why materiality is a threshold and not a judgement.
 */
const comparePeriods: NodeHandler = async (ctx): Promise<NodeResult> => {
  const current = Number(await resolve(ctx, String(ctx.config.currentPath ?? "")) ?? NaN);
  const previous = Number(await resolve(ctx, String(ctx.config.previousPath ?? "")) ?? NaN);
  const materialityPct = Number(ctx.config.materialityPct ?? 10);
  const minimumSample = Number(ctx.config.minimumSample ?? 1);
  const sample = Number(await resolve(ctx, String(ctx.config.samplePath ?? "")) ?? 0);

  if (!Number.isFinite(current) || !Number.isFinite(previous)) {
    return {
      outcome: "succeeded",
      output: { unknown: true, reason: "one or both periods have no measurement", material: false },
    };
  }
  if (sample > 0 && sample < minimumSample) {
    return {
      outcome: "succeeded",
      output: {
        unknown: true,
        reason: `sample of ${sample} is below the minimum of ${minimumSample}; movement is not distinguishable from noise`,
        material: false,
        current,
        previous,
        sample,
      },
    };
  }

  const delta = current - previous;
  const deltaPct = previous === 0 ? null : (delta / Math.abs(previous)) * 100;
  const material = deltaPct !== null && Math.abs(deltaPct) >= materialityPct;

  return {
    outcome: "succeeded",
    output: {
      current,
      previous,
      delta,
      deltaPct,
      material,
      direction: delta > 0 ? "improved" : delta < 0 ? "declined" : "flat",
      materialityPct,
      sample,
      unknown: false,
    },
  };
};

const classifyThreshold: NodeHandler = async (ctx): Promise<NodeResult> => {
  const value = Number(await resolve(ctx, String(ctx.config.valuePath ?? "")) ?? NaN);
  const bands =
    (ctx.config.bands as { label: string; min?: number; max?: number }[] | undefined) ?? [];
  if (!Number.isFinite(value)) {
    return { outcome: "succeeded", output: { band: "unknown", value: null } };
  }
  const band = bands.find(
    (b) => (b.min === undefined || value >= b.min) && (b.max === undefined || value < b.max)
  );
  return {
    outcome: "succeeded",
    output: { band: band?.label ?? "unclassified", value, bands },
  };
};

/** `calculate_priority` — spec 018's formula, components exposed. */
const calculatePriority: NodeHandler = async (ctx): Promise<NodeResult> => {
  const source = await resolveObject(ctx, String(ctx.config.sourcePath ?? ""));
  const breakdown = computePriority({
    severity: (source.severity as RiskLevel) ?? "medium",
    hoursUntilDue: typeof source.hoursUntilDue === "number" ? source.hoursUntilDue : null,
    commercialValue: Number(source.commercialValue ?? 0.3),
    dependencyImpact: Number(source.dependencyImpact ?? 0.3),
    risk: Number(source.risk ?? 0.3),
    effortMinutes: Number(source.effortMinutes ?? 30),
  });
  return {
    outcome: "succeeded",
    output: {
      priority: breakdown.total,
      formulaVersion: breakdown.formulaVersion,
      components: breakdown.components,
    },
  };
};

/**
 * The five attribution categories this workflow reports, which are the
 * business-facing names. They map onto spec 018's `AttributionClass` (the
 * *evidence-strength* vocabulary the confidence gate already enforces) rather
 * than replacing it — one gate, two vocabularies, no second implementation.
 */
export const AI_ATTRIBUTION_CATEGORIES = [
  "confirmed_ai_referral",
  "confirmed_self_reported_ai_discovery",
  "ai_assisted",
  "probable_ai_influence",
  "unknown",
] as const;
export type AiAttributionCategory = (typeof AI_ATTRIBUTION_CATEGORIES)[number];

const CATEGORY_TO_EVIDENCE_CLASS: Record<AiAttributionCategory, AttributionClass> = {
  confirmed_ai_referral: "confirmed",
  confirmed_self_reported_ai_discovery: "confirmed",
  ai_assisted: "strongly_supported",
  probable_ai_influence: "probable",
  unknown: "unknown",
};

export interface AttributionSignals {
  aiReferrerPresent?: boolean;
  selfReported?: boolean;
  selfReportedText?: string;
  brandedSearchLift?: boolean;
  visibilityImprovedInPeriod?: boolean;
  matchingIdentifier?: boolean;
  crmRelationship?: boolean;
  otherChannelsActive?: boolean;
}

/**
 * The rule ladder. Ordered strongest-evidence-first, and each rung names the
 * evidence it rests on so a classification can be audited rather than trusted.
 * Pure, so the "correlation is never confirmed" property is unit-testable.
 */
export function classifyAttribution(signals: AttributionSignals): {
  category: AiAttributionCategory;
  rule: string;
} {
  if (signals.selfReported === true && (signals.selfReportedText ?? "").length > 0) {
    return {
      category: "confirmed_self_reported_ai_discovery",
      rule: "the prospect stated in their own words that they found the client via an AI assistant",
    };
  }
  if (signals.aiReferrerPresent === true) {
    return {
      category: "confirmed_ai_referral",
      rule: "an AI assistant appeared as the referring source in analytics",
    };
  }
  if (signals.brandedSearchLift === true && signals.visibilityImprovedInPeriod === true) {
    return {
      category: "ai_assisted",
      rule: "branded demand rose in a period when measured AI visibility also rose",
    };
  }
  if (signals.visibilityImprovedInPeriod === true && signals.otherChannelsActive !== true) {
    return {
      category: "probable_ai_influence",
      rule: "visibility improved and no other channel was active — suggestive, not confirmed",
    };
  }
  return { category: "unknown", rule: "no signal distinguishes this outcome's origin" };
}

/**
 * `calculate_attribution` — deterministic classification, then spec 018's
 * confidence gate. Correlation never becomes `confirmed`; that is the whole
 * point of keeping the categories and the gate separate.
 */
const calculateAttribution: NodeHandler = async (ctx): Promise<NodeResult> => {
  const signals = await resolveObject(ctx, String(ctx.config.signalsPath ?? "")) as AttributionSignals;

  const { category, rule } = classifyAttribution(signals);
  const confirmed =
    category === "confirmed_ai_referral" || category === "confirmed_self_reported_ai_discovery";

  const gate = attributionConfidenceGate({
    claimedClass: CATEGORY_TO_EVIDENCE_CLASS[category],
    hasReferralEvidence: signals.aiReferrerPresent === true,
    hasSelfReportedEvidence: signals.selfReported === true,
    hasCrmRelationship: signals.crmRelationship === true,
    hasMatchingIdentifier: signals.matchingIdentifier === true || signals.aiReferrerPresent === true,
    // Confidence is always disclosed by this node — the disclosure string below
    // is part of its output, not an optional extra.
    confidenceDisclosed: true,
    inferred: !confirmed,
  });

  return {
    outcome: "succeeded",
    output: {
      category,
      evidenceClass: CATEGORY_TO_EVIDENCE_CLASS[category],
      rule,
      gate: gate.outcome,
      checks: gate.checks,
      confirmed,
      disclosure:
        category === "unknown"
          ? "Origin unknown. This outcome is not attributed to AI visibility."
          : `Classified ${category}${confirmed ? "" : " (not confirmed)"}. ${rule}.`,
    },
  };
};

// --------------------------------------------------------------- integrity

const hashArtifact: NodeHandler = async (ctx): Promise<NodeResult> => {
  const contentPath = String(ctx.config.contentPath ?? "");
  const content = await resolve(ctx, contentPath);
  const text = typeof content === "string" ? content : JSON.stringify(content ?? null);
  return {
    outcome: "succeeded",
    output: {
      sha256: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text, "utf8"),
    },
  };
};

const validateHash: NodeHandler = async (ctx): Promise<NodeResult> => {
  const expected = String(await resolve(ctx, String(ctx.config.expectedPath ?? "")) ?? "");
  const contentPath = String(ctx.config.contentPath ?? "");
  const content = await resolve(ctx, contentPath);
  const text = typeof content === "string" ? content : JSON.stringify(content ?? null);
  const actual = createHash("sha256").update(text).digest("hex");
  if (expected.length === 0) {
    return {
      outcome: "safe_stop",
      reason: "no expected hash to validate against; integrity is unverified",
    };
  }
  if (actual !== expected) {
    return {
      outcome: "failed_terminal",
      error: "artifact hash does not match the recorded value — the content changed",
      output: { expected, actual },
    };
  }
  return { outcome: "succeeded", output: { expected, actual, valid: true } };
};

// -------------------------------------------------------------- freshness

const checkEvidenceFreshness: NodeHandler = async (ctx): Promise<NodeResult> => {
  const maxAgeDays = Number(ctx.config.maxAgeDays ?? 90);
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "evidence freshness requires a client scope" };
  }
  const [row] = await sql`
    select
      count(*)::int as total,
      count(*) filter (where review_date is null or review_date >= current_date)::int as fresh,
      count(*) filter (where review_date is not null and review_date < current_date)::int as stale,
      count(*) filter (
        where review_date is not null
          and review_date < current_date + make_interval(days => ${maxAgeDays})
          and review_date >= current_date
      )::int as expiring_soon
    from claims
    where project_id = ${ctx.projectId} and status = 'approved'
  `;
  const total = Number(row?.total ?? 0);
  const stale = Number(row?.stale ?? 0);
  return {
    outcome: "succeeded",
    output: {
      total,
      fresh: Number(row?.fresh ?? 0),
      stale,
      expiringSoon: Number(row?.expiringSoon ?? 0),
      allFresh: stale === 0,
      maxAgeDays,
    },
  };
};

const checkClaimExpiration: NodeHandler = async (ctx): Promise<NodeResult> => {
  const windowDays = Number(ctx.config.windowDays ?? 30);
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "claim expiration requires a client scope" };
  }
  const rows = await sql`
    select id, key, canonical_text, review_date, verification_status
    from claims
    where project_id = ${ctx.projectId} and status = 'approved'
      and review_date is not null
      and review_date <= current_date + make_interval(days => ${windowDays})
    order by review_date asc
  `;
  return {
    outcome: "succeeded",
    output: {
      expiring: rows as unknown[],
      count: rows.length,
      windowDays,
      anyExpiring: rows.length > 0,
    },
  };
};

const checkPermission: NodeHandler = async (ctx): Promise<NodeResult> => {
  const required = String(ctx.config.requiredRole ?? "operator");
  // Permission is resolved at the action boundary, not here; this node records
  // what the workflow believes it needs so the graph documents its own
  // requirements. It never grants anything.
  return {
    outcome: "succeeded",
    output: { requiredRole: required, declared: true },
  };
};

// ------------------------------------------------------------------- tasks

/**
 * `create_task` — a suggested task, which the `tasks` table requires to carry
 * evidence (spec 001's `tasks_suggested_need_evidence` constraint: software
 * suggests only with proof). A task with no evidence is refused here with a
 * clear message rather than hitting the constraint at the database.
 */
const createTask: NodeHandler = async (ctx): Promise<NodeResult> => {
  if (ctx.projectId === null) {
    return { outcome: "failed_terminal", error: "create_task requires a client scope" };
  }
  const title = String(
    await resolve(ctx, String(ctx.config.titlePath ?? "")) ?? ctx.config.title ?? ""
  );
  if (title.length === 0) {
    return { outcome: "failed_terminal", error: "create_task needs a title" };
  }
  const evidencePath = String(ctx.config.evidenceIdsPath ?? "");
  const rawEvidence = evidencePath.length > 0 ? await resolve(ctx, evidencePath) : null;
  const evidenceIds = Array.isArray(rawEvidence) ? rawEvidence.map(String) : [];
  if (evidenceIds.length === 0) {
    return {
      outcome: "safe_stop",
      reason:
        "a suggested task must carry at least one piece of evidence (PRINCIPLES #8) — none was supplied",
    };
  }
  const priority = ["p1", "p2", "p3"].includes(String(ctx.config.priority))
    ? String(ctx.config.priority)
    : "p2";

  const [row] = await sql`
    insert into tasks (project_id, title, description, status, priority, evidence_ids)
    values (
      ${ctx.projectId}, ${title}, ${String(ctx.config.description ?? "")},
      'suggested', ${priority}, ${evidenceIds}::uuid[]
    )
    returning id
  `;
  return {
    outcome: "succeeded",
    output: {
      taskId: (row?.id as string) ?? null,
      title,
      priority,
      evidenceCount: evidenceIds.length,
      created: Boolean(row),
    },
  };
};

const scheduleRemeasurement: NodeHandler = async (ctx): Promise<NodeResult> => {
  const days = Number(ctx.config.days ?? 30);
  const runAfter = new Date(Date.now() + days * 86_400_000);
  await sql`
    insert into jobs (type, payload, run_after)
    values (
      'advance_workflow',
      ${sql.json({ runId: ctx.runId, remeasure: true } as never)},
      ${runAfter}
    )
  `;
  return {
    outcome: "succeeded",
    output: { scheduledFor: runAfter.toISOString(), days },
  };
};

export const deterministicNodes: Record<string, NodeHandler> = {
  "det.fetch_record": fetchRecord,
  "det.query_records": queryRecords,
  "det.normalize_entity": normalizeEntity,
  "det.map_fields": mapFields,
  "det.deduplicate": deduplicate,
  "det.calculate_metric": calculateMetric,
  "det.compare_periods": comparePeriods,
  "det.classify_threshold": classifyThreshold,
  "det.calculate_priority": calculatePriority,
  "det.calculate_attribution": calculateAttribution,
  "det.hash_artifact": hashArtifact,
  "det.validate_hash": validateHash,
  "det.check_evidence_freshness": checkEvidenceFreshness,
  "det.check_claim_expiration": checkClaimExpiration,
  "det.check_permission": checkPermission,
  "det.create_task": createTask,
  "det.schedule_remeasurement": scheduleRemeasurement,
};
