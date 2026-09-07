/**
 * Open-tracking pixel (spec 092). Public GET, like /audit/[token]: an
 * unauthenticated surface a mail client fetches, so it cannot be a server
 * action. Always serves the same 1×1 transparent GIF with the same status —
 * a known token records an open row, an unknown token records nothing, and
 * neither case is distinguishable from outside (no validity oracle).
 */
import { sql } from "@/db/client";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

// Smallest valid transparent GIF (43 bytes).
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64"
);

const TOKEN_SHAPE = /^[0-9a-f]{32}$/;

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
  const { token } = await params;
  if (TOKEN_SHAPE.test(token)) {
    try {
      const [send] = await sql`
        select id from prospect_outreach_sends where open_token = ${token}
      `;
      if (send) {
        // Raw evidence, interpreted at read time: prefetch/proxy dedup is a
        // display concern, never a write-time filter.
        const ip =
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
        const userAgent = request.headers.get("user-agent");
        await sql`
          insert into outreach_email_opens (send_id, ip, user_agent)
          values (${send.id}, ${ip}, ${userAgent})
        `;
      }
    } catch (err) {
      // The pixel must never fail: a tracking outage is invisible to the
      // recipient and merely undercounts, which the metric already admits.
      log("warn", "outreach.open_record_failed", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }
  return new Response(PIXEL, {
    status: 200,
    headers: {
      "content-type": "image/gif",
      "content-length": String(PIXEL.length),
      // A cached pixel would swallow repeat opens.
      "cache-control": "no-store, max-age=0",
    },
  });
}
