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
    // Provider keys read by their adapters (spec 059: declared, not stray).
    GOOGLE_API_KEY: z.string().optional(),
    PERPLEXITY_API_KEY: z.string().optional(),
    // Connector credential envelope key (AES-256-GCM, base64 32 bytes).
    AUTOMATION_CREDENTIAL_KEY: z.string().optional(),
    // Operator webhook for digests and system alerts (spec 059).
    DIGEST_WEBHOOK_URL: z.string().url().optional(),
    // Spec 129 kill switch: "false" parks QA-passed report handoffs for a
    // human send instead of scheduling the threaded reply.
    REPORT_HANDOFF_AUTOSEND: z.string().optional(),
    // Spec 137 autonomous fulfillment lane. Mode: SHADOW (default — prepare
    // everything, record the verdict, transmit nothing) | CANARY | 
    // NARROW_AUTONOMOUS | MANUAL_ONLY. Percent applies to CANARY. The kill
    // switch forbids autonomous transmission in every mode.
    AUTONOMOUS_POSITIVE_REPLY_MODE: z.string().optional(),
    AUTONOMOUS_POSITIVE_REPLY_CANARY_PERCENT: z.string().optional(),
    AUTONOMOUS_POSITIVE_REPLY_KILL_SWITCH: z.string().optional(),
    // Spec 138 release policy: report_and_video (default — a handoff holds at
    // WAITING_FOR_VIDEO until a releasable walkthrough exists) | report_only.
    FULFILLMENT_RELEASE_POLICY: z.string().optional(),
    // Spec 138 personalized video walkthrough. Mode: SHADOW (default —
    // prepare, QA, stage, never deliver) | CANARY | MANUAL_ONLY. The kill
    // switch stops NEW video jobs; the release kill switch stops release of
    // finished videos in every mode. Distribution: local_storage (default)
    // | unlisted_youtube (declared, not implemented). TTS provider "mock"
    // and the fixture intro are refused in production.
    VIDEO_WALKTHROUGH_MODE: z.string().optional(),
    VIDEO_WALKTHROUGH_KILL_SWITCH: z.string().optional(),
    VIDEO_WALKTHROUGH_RELEASE_KILL_SWITCH: z.string().optional(),
    VIDEO_DISTRIBUTION: z.string().optional(),
    VIDEO_TTS_PROVIDER: z.string().optional(),
    VIDEO_ALLOW_FIXTURE_INTRO: z.string().optional(),
    VIDEO_LOCAL_STORAGE_SERVABLE: z.string().optional(),
    ELEVENLABS_API_KEY: z.string().optional(),
    ELEVENLABS_VOICE_ID: z.string().optional(),
    // MCP server actor (spec 033) — required only by `npm run mcp`.
    MCP_USER_ID: z.string().optional(),
    // Spend ceiling override (lib/constants.ts falls back to $25).
    DAILY_SPEND_CEILING_USD: z.string().optional(),
    // Prospect audit page commission-estimate rate (defaults to 0.025).
    COMMISSION_RATE_ESTIMATE: z.string().optional(),
    // Audit-page display credibility fields (PR B) — display only; the
    // outbound sender of record is outreach_sender_identity (spec 052).
    SENDER_COMPANY: z.string().optional(),
    SENDER_CREDENTIAL: z.string().optional(),
    // Test/demo fences (spec 050) — never set in production.
    ALLOW_MOCK_PROVIDER: z.string().optional(),
    ALLOW_MOCK_SCORING: z.string().optional(),
    // Production-behavior toggles previously read outside this schema
    // (cleanup 2026-08-18). ALLOW_DEV_AUTH_IN_PROD=1 disables the
    // production dev-auth refusal (devAuthRefusalReason below) — e2e only,
    // never on a real deployment. QA_SOURCE_LINK_CHECKS=off skips the
    // publish-time dead-link check (lib/qa/preflight.ts) — a test-only
    // escape hatch, not an operator control (DECISIONS 2026-08-15).
    ALLOW_DEV_AUTH_IN_PROD: z.string().optional(),
    QA_SOURCE_LINK_CHECKS: z.string().optional(),
    // Backups (spec 059). Production MUST set the encryption key.
    BACKUP_ENCRYPTION_KEY: z.string().optional(),
    BACKUP_UPLOAD_CMD: z.string().optional(),
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

/**
 * Base for absolute URLs the app issues about itself — auth redirects and the
 * magic-link callback. Behind Railway's proxy the request's own origin is the
 * container's internal hostname (e.g. https://98d71eb6ee29:8080), so anything
 * built from it is unreachable from outside. APP_URL wins whenever set; the
 * request-derived origin is only a dev fallback.
 */
export function publicOrigin(
  requestOrigin: string,
  appUrl: string | undefined = process.env.APP_URL
): string {
  return appUrl ?? requestOrigin;
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
