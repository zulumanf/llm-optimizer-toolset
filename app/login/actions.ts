"use server";

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { z } from "zod";
import { sql } from "@/db/client";
import { getEnv } from "@/lib/env";
import { log } from "@/lib/logger";
import { supabaseRouteClient } from "@/lib/supabase/server";

const emailSchema = z.string().email().max(320);

/**
 * Send a one-time sign-in link.
 *
 * Two properties worth stating, because both look like bugs from the outside:
 *
 * 1. **The response never reveals whether an address is provisioned.** An
 *    unknown email produces the same "check your inbox" page as a known one.
 *    Otherwise this form becomes a way for anyone to enumerate who works here.
 * 2. **`shouldCreateUser: false`.** Supabase would otherwise happily create an
 *    account for any address that asks. Provisioning is an admin act; a magic
 *    link is a way to prove you own an address, not a way to join.
 */
export async function requestMagicLink(formData: FormData): Promise<void> {
  const env = getEnv();
  if (env.AUTH_MODE !== "supabase") redirect("/");

  const parsed = emailSchema.safeParse(String(formData.get("email") ?? "").trim());
  if (!parsed.success) redirect("/login?error=invalid");

  const email = parsed.data.toLowerCase();

  // Only send to an address this workspace already knows. Checked here rather
  // than relying on Supabase alone, because `users` — not auth.users — is what
  // grants access.
  const [known] = await sql`
    select id from users where lower(email) = ${email} and active
  `;

  if (known) {
    const supabase = await supabaseRouteClient();
    const origin = (await headers()).get("origin") ?? "http://localhost:3000";
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: `${origin}/auth/callback`,
      },
    });
    if (error) {
      log("error", "auth.magic_link_failed", { reason: error.message });
    }
  } else {
    // Logged so a locked-out operator is diagnosable, without telling the
    // browser anything it did not already know.
    log("warn", "auth.magic_link_unknown_address", { email });
  }

  redirect("/login?sent=1");
}

export async function signOut(): Promise<void> {
  const env = getEnv();
  if (env.AUTH_MODE === "supabase") {
    const supabase = await supabaseRouteClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}
