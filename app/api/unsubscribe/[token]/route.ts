/**
 * One-click unsubscribe endpoint (spec 157, RFC 8058). Public and
 * unauthenticated like /api/open: the target of the List-Unsubscribe header,
 * POSTed by mail providers on the recipient's behalf — so it is a route
 * handler, not a server action (DECISIONS.md 2026-10-21).
 *
 * No validity oracle: known, unknown and malformed tokens get the same
 * response. GET never unsubscribes (link scanners prefetch) — it redirects to
 * the human confirmation page.
 */
import { redeemUnsubscribeToken } from "@/lib/outreach/unsubscribe";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** RFC 8058 §3.1: the POST body a one-click client sends. */
const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

function pagePath(token: string, done: boolean): string {
  return `/unsubscribe/${encodeURIComponent(token)}${done ? "?done=1" : ""}`;
}

function redirectTo(path: string): Response {
  // Relative Location (RFC 9110 allows it): correct behind any proxy origin.
  return new Response(null, { status: 303, headers: { location: path, "cache-control": "no-store" } });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await params;
  return redirectTo(pagePath(token, false));
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await params;
  const body = await request.text().catch(() => "");
  const fields = new URLSearchParams(body);
  const oneClick = body.includes(ONE_CLICK_BODY);
  const confirmed = oneClick || fields.get("confirm") === "1";
  if (confirmed) {
    try {
      await redeemUnsubscribeToken(token, oneClick ? "one_click" : "page");
    } catch (err) {
      // Same answer either way; the failure is visible to operators only.
      log("error", "outreach.unsubscribe_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  if (oneClick) {
    return new Response("Unsubscribed.\n", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return redirectTo(pagePath(token, confirmed));
}
