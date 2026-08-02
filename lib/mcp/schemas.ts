/**
 * MCP tool input schemas (spec 033). Pure zod — no database or service
 * imports, so schema contracts are unit-testable on a machine without
 * Postgres. Every schema is `.strict()`: unknown keys are rejected, not
 * stripped. Deep domain validation (pinned models, pricing, frozen
 * versions) stays in the services; these schemas guard shape only.
 */
import { z } from "zod";

export const uuid = z.string().uuid();

export const CITATION_SOURCES_LIMIT_MAX = 50;
export const IDEMPOTENCY_KEY_MAX = 128;

export const includeArchivedSchema = z
  .object({ include_archived: z.boolean().default(false) })
  .strict();
export const projectIdSchema = z.object({ project_id: uuid }).strict();
export const runIdSchema = z.object({ run_id: uuid }).strict();
export const interventionIdSchema = z
  .object({ intervention_id: uuid })
  .strict();
export const emptySchema = z.object({}).strict();

export const citationSourcesSchema = z
  .object({
    project_id: uuid,
    limit: z.number().int().min(1).max(CITATION_SOURCES_LIMIT_MAX).default(15),
  })
  .strict();

export const gapReportSchema = z
  .object({ project_id: uuid, run_id: uuid.optional() })
  .strict();

const providerConfigInput = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    repetitions: z.number().int().min(1).max(10).default(1),
  })
  .strict();

const idempotencyKey = z.string().min(1).max(IDEMPOTENCY_KEY_MAX).optional();

export const runPromptSetSchema = z
  .object({
    project_id: uuid,
    prompt_set_version_id: uuid,
    label: z.string().min(1).max(80),
    providers: z.array(providerConfigInput).min(1),
    budget_usd: z.number().min(0.5).max(100),
    dry_run: z.boolean().default(false),
    idempotency_key: idempotencyKey,
  })
  .strict();

export const createExperimentSchema = z
  .object({
    project_id: uuid,
    title: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    hypothesis: z.string().max(500).optional(),
    shipped_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    urls: z.array(z.string().url()).max(10).default([]),
    prompt_set_version_id: uuid,
    task_id: uuid.optional(),
    dry_run: z.boolean().default(false),
    idempotency_key: idempotencyKey,
  })
  .strict();

export const searchLearningsSchema = z
  .object({
    query: z.string().min(1).max(200).optional(),
    project_id: uuid.optional(),
    category: z
      .enum(["content", "authority", "entity", "technical", "distribution", "process", "other"])
      .optional(),
    include_retired: z.boolean().default(false),
  })
  .strict();

export const recordLearningSchema = z
  .object({
    project_id: uuid.nullish(),
    category: z.enum([
      "content", "authority", "entity", "technical", "distribution", "process", "other",
    ]),
    statement: z.string().min(1).max(500),
    rationale: z.string().max(2000).default(""),
    confidence_label: z.enum([
      "confirmed", "strongly_supported", "correlated", "probable", "unknown",
    ]),
    source_action_outcome_ids: z.array(uuid).max(20).default([]),
    evidence_note: z.string().max(1000).optional(),
    dry_run: z.boolean().default(false),
    idempotency_key: idempotencyKey,
  })
  .strict();

export type SearchLearningsInput = z.infer<typeof searchLearningsSchema>;
export type RecordLearningInput = z.infer<typeof recordLearningSchema>;

export const promptClustersSchema = z
  .object({ prompt_set_id: uuid })
  .strict();

export const importPromptsSchema = z
  .object({
    prompt_set_id: uuid,
    content: z.string().min(1).max(500_000),
    dry_run: z.boolean().default(false),
    idempotency_key: idempotencyKey,
  })
  .strict();

export type ImportPromptsInput = z.infer<typeof importPromptsSchema>;

export type RunPromptSetInput = z.infer<typeof runPromptSetSchema>;
export type CreateExperimentInput = z.infer<typeof createExperimentSchema>;
