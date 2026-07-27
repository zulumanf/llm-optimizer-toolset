/**
 * Env validated once at startup (docs/11): the app refuses to boot with
 * missing config. Server-side only — never import from client components.
 */
import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url().or(z.string().startsWith("postgres://")),
  AUTH_MODE: z.enum(["dev", "supabase"]).default("dev"),
  DEV_USER_EMAIL: z.string().email().default("dev@parva.local"),
  DEV_USER_NAME: z.string().min(1).default("Dev User"),
  DEV_USER_ROLE: z.enum(["admin", "operator"]).default("admin"),
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
