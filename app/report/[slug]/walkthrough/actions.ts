"use server";

import { headers } from "next/headers";
import { sql } from "@/db/client";
import { requestWalkthrough, type WalkthroughResult } from "@/lib/prospects/walkthrough";
import { readReportSession } from "@/lib/prospects/report-session";

/** Session-gated (spec 134): the browser proves it holds an authorized
 * report session for this slug; the audit token never leaves the server. */
export async function submitReportWalkthroughRequest(input: unknown): Promise<WalkthroughResult> {
  const slug = typeof input === "object" && input !== null && "reportSlug" in input ? String((input as { reportSlug: unknown }).reportSlug) : "";
  const session = slug ? await readReportSession(slug) : null;
  if (!session) return { ok: false, error: "This report's session has ended. Open the link from your email again." } as WalkthroughResult;
  const rest = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  // The token stays server-side: looked up here, handed to the existing
  // token-keyed request path, never rendered.
  const [audit] = await sql`select access_token from prospect_audits where id = ${session.auditId} and status = 'published'`;
  if (!audit?.accessToken) return { ok: false, error: "This report is no longer available." } as WalkthroughResult;
  const hdrs = await headers();
  return requestWalkthrough(
    { ...rest, reportSlug: undefined, token: audit.accessToken as string },
    {
      ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: hdrs.get("user-agent"),
    }
  );
}
