/**
 * The HTTP side of the invitation exchange (spec 134), shared by the
 * canonical /report/<slug>/<key> route and every legacy /audit/... route:
 * validate the credential, mint the HttpOnly session cookie, 303 to the
 * clean URL. HEAD has no side effects. Every outcome lands on /report/…,
 * which renders only for a valid session — an invalid credential lands on
 * the private-report state exactly like a stranger's paste.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUserOrNull, isStaff } from "@/lib/auth";
import { exchangeInvitation, isReportSlug, parseReportNext, presentedTokensFromCookies, type ReportNext } from "@/lib/prospects/report-access";
import { sessionCookieOptions } from "@/lib/prospects/report-session";
import { publicOrigin } from "@/lib/env";
import { log } from "@/lib/logger";

export const PRIVATE_HEADERS = {
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
};

/** Where an unknown credential lands: a slug-shaped path that renders the
 * private state. Never a real report's slug unless the URL carried one. */
const PRIVATE_STATE_SLUG = "private";

function privateRedirect(origin: string, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, origin), { status: 303, headers: PRIVATE_HEADERS });
}

/** HEAD (mail scanners, link checkers): 204, no session, no ledger row. */
export function headResponse(): Response {
  return new Response(null, { status: 204, headers: PRIVATE_HEADERS });
}

export async function handleInvitation(
  request: NextRequest,
  input: { credential: string; slugHint: string | null; next?: ReportNext | null }
): Promise<Response> {
  const origin = publicOrigin(request.nextUrl.origin);
  if (input.slugHint !== null && !isReportSlug(input.slugHint)) {
    return new Response(null, { status: 404, headers: PRIVATE_HEADERS });
  }
  const fallbackSlug = input.slugHint ?? PRIVATE_STATE_SLUG;
  const next = input.next ?? parseReportNext(request.nextUrl.searchParams.get("next"));
  const viewer = await getCurrentUserOrNull();
  let result;
  try {
    result = await exchangeInvitation(input.credential, {
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: request.headers.get("user-agent"),
      staff: viewer !== null && isStaff(viewer),
      // Slug unknown until resolution: present every report cookie; each is
      // hash-verified against the resolved prospect, so a repeat click on any
      // form of the link reuses the session instead of spending an activation.
      presentedTokens: presentedTokensFromCookies(request.cookies.getAll(), null),
    });
  } catch (err) {
    log("error", "report_access.exchange_failed", { error: err instanceof Error ? err.message : String(err) });
    return privateRedirect(origin, `/report/${fallbackSlug}`);
  }
  if (result.kind === "invalid") return privateRedirect(origin, `/report/${fallbackSlug}`);
  const target = `/report/${result.slug}${next ? `/${next}` : ""}`;
  if (result.kind === "limit") return privateRedirect(origin, `/report/${result.slug}?state=limit`);
  if (result.kind === "scanner") return privateRedirect(origin, target);
  const response = privateRedirect(origin, target);
  if (result.sessionToken) {
    const { name, ...options } = sessionCookieOptions(result.slug);
    response.cookies.set(name, result.sessionToken, options);
  }
  return response;
}
