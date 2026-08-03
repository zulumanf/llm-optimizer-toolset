import { z } from "zod";
import { PROVIDER_IDS } from "@/lib/ai/types";
import { isKnownModel } from "@/lib/ai/registry";
import { hasPricing } from "@/lib/ai/pricing";

export const RUN_LABEL_MAX = 80;
export const MAX_REPETITIONS = 10;
export const BUDGET_MIN_USD = 0.5;
export const BUDGET_MAX_USD = 100;

export const providerConfigSchema = z
  .object({
    provider: z.enum(PROVIDER_IDS),
    model: z.string().min(1),
    repetitions: z.number().int().min(1).max(MAX_REPETITIONS),
  })
  .superRefine((cfg, ctx) => {
    if (!isKnownModel(cfg.provider, cfg.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Model ${cfg.model} is not in the pinned list for ${cfg.provider}.`,
      });
      return;
    }
    // A model without a pricing row would record every call as $0 and the
    // budget cap could never fire — refuse at creation, not mid-run.
    if (!hasPricing(cfg.model)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Model ${cfg.model} has no pricing entry (lib/ai/pricing.ts) — the run budget would be unenforceable.`,
      });
    }
  });

export const runConfigSchema = z.object({
  projectId: z.string().uuid(),
  promptSetVersionId: z.string().uuid(),
  providers: z.array(providerConfigSchema).min(1),
  budgetUsd: z.number().min(BUDGET_MIN_USD).max(BUDGET_MAX_USD),
});

export const startRunSchema = runConfigSchema.extend({
  label: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "Label is required.").max(RUN_LABEL_MAX)),
});

export const estimateRunSchema = z.object({
  promptSetVersionId: z.string().uuid(),
  providers: z.array(providerConfigSchema).min(1),
});

export const runIdSchema = z.object({ runId: z.string().uuid() });

export type StartRunInput = z.infer<typeof startRunSchema>;
