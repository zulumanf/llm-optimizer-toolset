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
    /** Public origin of the deployed app (no trailing slash), e.g.
     * https://avos.example.com. Everything that leaves the building — audit
     * share links, outreach drafts — builds absolute URLs from this, never
     * from window.location (which is localhost on the operator's machine).
     * Optional so dev boots; link-bearing features degrade without it. */
    APP_URL: z.string().url().optional(),
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

/**
 * Why a production process may not serve with dev auth: AUTH_MODE defaults to
 * "dev", and dev mode hands every request a passwordless admin session. A
 * deploy that forgets one env var must therefore fail closed, not open — the
 * same reasoning as ALLOW_MOCK_PROVIDER in lib/ai/registry.ts: forgetting is
 * silent, overriding must be a visible act.
 *
 * Returns the refusal message, or null when serving is allowed. `next build`
 * prerenders under NODE_ENV=production with no real traffic, so the build
 * phase is exempt; the check re-fires on every request once serving.
 */
type DevAuthEnv = Partial<
  Record<"NODE_ENV" | "AUTH_MODE" | "NEXT_PHASE" | "ALLOW_DEV_AUTH_IN_PROD", string>
>;

export function devAuthRefusalReason(
  env: DevAuthEnv = process.env
): string | null {
  if (env.AUTH_MODE === "supabase") return null;
  if (env.NODE_ENV !== "production") return null;
  if (env.NEXT_PHASE === "phase-production-build") return null;
  if (env.ALLOW_DEV_AUTH_IN_PROD === "1") return null;
  return (
    "Refusing to serve: AUTH_MODE is not 'supabase' in a production process, " +
    "which would give every visitor a passwordless admin session. Set " +
    "AUTH_MODE=supabase with the SUPABASE_* variables, or set " +
    "ALLOW_DEV_AUTH_IN_PROD=1 only if this instance is deliberately private."
  );
}

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
