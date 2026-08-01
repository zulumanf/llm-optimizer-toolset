/**
 * Env validated once at startup (docs/11): the app refuses to boot with
 * missing config. Server-side only — never import from client components.
 */
import { z } from "zod";

const envSchema = z
  .object({
    DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")),
    AUTH_MODE: z.enum(["dev", "supabase"]).default("dev"),
    DEV_USER_EMAIL: z.string().email().default("dev@avos.local"),
    DEV_USER_NAME: z.string().min(1).default("Dev User"),
    DEV_USER_ROLE: z.enum(["admin", "operator"]).default("admin"),
    // Provider keys and cron secret are optional at boot; the features that
    // need them fail with a classified error when missing (lib/ai adapters)
    ANTHROPIC_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    CRON_SECRET: z.string().optional(),
    // Supabase (spec 014). Optional at field level so `AUTH_MODE=dev` boots —
    // and the whole test suite runs — with no identity provider reachable.
    // That is an explicit acceptance criterion, not a convenience.
    SUPABASE_URL: z.string().url().optional(),
    SUPABASE_ANON_KEY: z.string().min(1).optional(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  })
  // …but required together the moment auth is switched on. Refusing to boot is
  // the point: an auth integration that starts and then 500s on the first
  // request is worse than one that never starts.
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE !== "supabase") return;
    for (const key of [
      "SUPABASE_URL",
      "SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
    ] as const) {
      if (!env[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is required when AUTH_MODE=supabase.`,
        });
      }
    }
  });

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(
        `Invalid environment: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`
      );
    }
    cached = parsed.data;
  }
  return cached;
}
