import "server-only";

/**
 * Supabase clients (spec 014). Server-side only.
 *
 * The `import "server-only"` on line 1 is the enforcement, not a comment: if
 * any client component ever imports this module — directly or through a chain
 * — the build fails rather than shipping the service-role key to a browser.
 * docs/10 requires that key never reach a bundle, and a build error is the
 * only version of that rule which cannot be forgotten during a refactor.
 *
 * Two clients, deliberately separated:
 *
 *   - `supabaseRouteClient()` acts AS THE SIGNED-IN USER, using the anon key
 *     plus their session cookie. Row-level security applies. Everything that
 *     serves a request should use this.
 *   - `supabaseAdminClient()` bypasses row-level security entirely. It exists
 *     for exactly two jobs — provisioning a user row and reading an identity
 *     during callback — and each call site says why.
 */
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { getEnv } from "@/lib/env";
import { ClassifiedError } from "@/lib/errors";

function requireConfig(): { url: string; anonKey: string } {
  const env = getEnv();
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new ClassifiedError(
      "internal",
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY, or run with AUTH_MODE=dev."
    );
  }
  return { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY };
}

/**
 * The request-scoped client. Reads and refreshes the session cookie, and is
 * subject to RLS because it carries the user's JWT rather than the service key.
 */
export async function supabaseRouteClient(): Promise<SupabaseClient> {
  const { url, anonKey } = requireConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components cannot set cookies. The middleware refreshes the
          // session on every request, so a failure here is expected and safe
          // rather than a silent auth bug.
        }
      },
    },
  });
}

/**
 * The privileged client. Bypasses RLS — treat every call as a security
 * decision and keep the surface tiny.
 */
export function supabaseAdminClient(): SupabaseClient {
  const env = getEnv();
  const { url } = requireConfig();
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ClassifiedError(
      "internal",
      "SUPABASE_SERVICE_ROLE_KEY is required for administrative Supabase calls."
    );
  }
  return createClient(url, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
