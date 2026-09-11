/**
 * Audit engagement beacon (spec 098). Public POST, like /api/open: the
 * prospect's browser reports engaged time, scroll milestones, and a handful
 * of section/evidence/CTA interactions against the view row that rendered
 * the page. Always answers 204 — an unknown view id, a malformed body, or a
 * database outage records nothing and is indistinguishable from outside.
 * Telemetry must never be a validity oracle or degrade the audit page.
 */
import { sql } from "@/db/client";
import { beaconSchema, MAX_BODY_BYTES } from "@/lib/prospects/engagement-beacon";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const NO_CONTENT = () => new Response(null, { status: 204, headers: { "cache-control": "no-store" } });

export async function POST(request: Request): Promise<Response> {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return NO_CONTENT();
    const parsed = beaconSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return NO_CONTENT();
    const { viewId, sessionId, visitorId, events } = parsed.data;
    // Internal (staff/operator-IP) views never grow engagement rows — the
    // read side filters them too, but not writing them keeps QA sessions
    // out of the evidence table entirely.
    const [view] = await sql`
      select id from prospect_audit_views where id = ${viewId} and not is_internal
    `;
    if (!view) return NO_CONTENT();
    const rows = events.map((e) => ({
      view_id: viewId,
      session_id: sessionId,
      visitor_id: visitorId ?? null,
      kind: e.kind,
      value: e.value ?? null,
      target: e.target ?? null,
    }));
    await sql`insert into prospect_audit_engagement_events ${sql(rows)}`;
  } catch (err) {
    log("warn", "audit.engagement_record_failed", {
      error: err instanceof Error ? err.message : "unknown",
    });
  }
  return NO_CONTENT();
}
