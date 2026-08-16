/**
 * Magic-link landing (spec 014).
 *
 * Exchanges the one-time code for a session, then verifies the account is
 * provisioned in `users` before letting it through. Supabase authenticating
 * someone only proves they control an inbox; whether they may use this
 * workspace is our decision, and it is made here rather than being assumed.
 */
import { NextResponse } from "next/server";
import { sql } from "@/db/client";
import { getEnv, publicOrigin } from "@/lib/env";
import { log } from "@/lib/logger";
import { supabaseRouteClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const env = getEnv();
  const url = new URL(request.url);
  const base = publicOrigin(url.origin);
  if (env.AUTH_MODE !== "supabase") {
    return NextResponse.redirect(new URL("/", base));
  }

  const code = url.searchParams.get("code");
  if (!code) return NextResponse.redirect(new URL("/login?error=callback", base));

  const supabase = await supabaseRouteClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data.user) {
    log("warn", "auth.callback_rejected", { reason: error?.message ?? "no user" });
    return NextResponse.redirect(new URL("/login?error=callback", base));
  }

  const [row] = await sql`
    select id, active from users where id = ${data.user.id}
       or lower(email) = ${(data.user.email ?? "").toLowerCase()}
  `;

  if (!row || !row.active) {
    // Authenticated, but not provisioned here. End the session rather than
    // leaving a valid cookie for an account that cannot do anything.
    await supabase.auth.signOut();
    log("warn", "auth.callback_unprovisioned", { userId: data.user.id });
    return NextResponse.redirect(new URL("/login?error=callback", base));
  }

  // First sign-in for a row created by an admin before the account existed:
  // adopt the Supabase uid so `users.id` and the auth uid stay identical.
  if (row.id !== data.user.id) {
    await sql`update users set id = ${data.user.id} where id = ${row.id}`;
  }

  await sql`update users set last_seen_at = now() where id = ${data.user.id}`;

  const next = url.searchParams.get("next");
  // Only same-origin paths, so a crafted link cannot bounce a fresh session
  // off to another site.
  const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(new URL(target, base));
}
