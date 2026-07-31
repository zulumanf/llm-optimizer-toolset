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
 * app with nothing reachable, which is an acceptance criterion.
 *
 * This is a convenience gate, NOT the security boundary. Middleware only sees
 * requests that match the matcher, and a route added tomorrow would not be
 * covered. The real enforcement is `getCurrentUser()` inside every server
 * action and page, which throws with no session regardless of routing.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/** Paths reachable without a session. */
const PUBLIC_PREFIXES = ["/login", "/auth/callback", "/api/cron", "/api/webhooks"];

export async function middleware(request: NextRequest): Promise<NextResponse> {
  if (process.env.AUTH_MODE !== "supabase") return NextResponse.next();

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
    const login = new URL("/login", request.url);
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
