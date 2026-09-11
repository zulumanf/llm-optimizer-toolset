/**
 * Session refresh and route protection (spec 014).
 *
 * Two jobs, in order:
 *  1. Refresh the Supabase session cookie. Server Components cannot write
 *     cookies, so without this a session would silently expire mid-use.
 *  2. Redirect unauthenticated requests to /login, carrying `next` so the
 *     operator lands where they were going instead of on the dashboard.
 *
 * In dev mode this is a pass-through: `AUTH_MODE=dev` must keep booting the
 * app with nothing reachable, which is an acceptance criterion — except in a
 * production process, where dev auth would mean a passwordless admin session
 * for every visitor, so serving is refused (devAuthRefusalReason).
 *
 * This is a convenience gate, NOT the security boundary. Middleware only sees
 * requests that match the matcher, and a route added tomorrow would not be
 * covered. The real enforcement is `getCurrentUser()` inside every server
 * action and page, which throws with no session regardless of routing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
<<<<<<< HEAD
import { devAuthRefusalReason } from "@/lib/env";
import { MARKETING_PREFIXES, marketingRewriteTarget } from "@/lib/marketing/constants";

/** Paths reachable without a session. `/audit` is the prospect audit page —
 * its own security is the high-entropy token (spec 032). Marketing pages
 * (spec 061) are the public site: anonymous by design, no client data. */
const PUBLIC_PREFIXES = [
  "/login",
  "/auth/callback",
  "/api/cron",
  "/api/health",
  "/api/webhooks",
  "/audit",
  ...MARKETING_PREFIXES,
];
=======
import { devAuthRefusalReason, publicOrigin } from "@/lib/env";

/** Paths reachable without a session. `/audit` is the prospect audit page —
 * its own security is the high-entropy token (spec 032). */
// `/api/open` is the email open-tracking pixel (spec 092): fetched by mail
// clients and image proxies, never by a session — the auth redirect was
// silently eating every open event (found live: zero opens ever recorded
// while the endpoint 307'd to /login).
// `/mcp`, `/healthz`, `/.well-known` are the remote MCP surface (spec 126):
// bearer-token machine clients, never a browser session — without these the
// auth redirect would 307 Grok's JSON-RPC to /login (the /api/open trap).
// `/report` is the private-report surface (spec 134): invitation exchange
// and session-gated clean URLs — its own security is the report session.
const PUBLIC_PREFIXES = ["/login", "/auth/callback", "/api/cron", "/api/health", "/api/webhooks", "/api/open", "/api/audit-signal", "/audit", "/report/", "/mcp", "/healthz", "/.well-known"];
>>>>>>> origin/main

export async function middleware(request: NextRequest): Promise<NextResponse> {
  // Apex-host rewrite (spec 061): the marketing domain's `/` is the homepage;
  // the app host's `/` stays the operator dashboard. Before auth on purpose —
  // the rewritten path is public either way.
  const rewriteTo = marketingRewriteTarget(
    request.headers.get("host"),
    request.nextUrl.pathname
  );
  if (rewriteTo) {
    return NextResponse.rewrite(new URL(rewriteTo, request.url));
  }

  if (process.env.AUTH_MODE !== "supabase") {
    const refusal = devAuthRefusalReason();
    if (refusal) return new NextResponse(refusal, { status: 503 });
    return NextResponse.next();
  }

  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  // Misconfigured rather than unauthenticated: fail closed, but say why.
  if (!url || !anonKey) {
    return new NextResponse(
      "AUTH_MODE=supabase but SUPABASE_URL/SUPABASE_ANON_KEY are missing.",
      { status: 503 }
    );
  }

  const response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value, options } of toSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates against Supabase; getSession() merely decodes a
  // cookie the client could have forged.
  const { data } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));

  if (!data.user && !isPublic) {
    const login = new URL("/login", publicOrigin(request.nextUrl.origin));
    if (path !== "/") login.searchParams.set("next", path);
    return NextResponse.redirect(login);
  }

  return response;
}

export const config = {
  // Everything except static assets. Cron and webhook routes are listed as
  // public above rather than excluded here, so they still get session refresh
  // if a signed-in operator happens to hit them.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
