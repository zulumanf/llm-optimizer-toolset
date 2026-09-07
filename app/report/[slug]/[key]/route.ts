/**
 * Invitation exchange (spec 134): GET /report/<slug>/<key> — the link a
 * prospect receives. One click: validate, set the session cookie, 303 to
 * the clean /report/<slug>. The credential is gone from the address bar.
 */
import type { NextRequest } from "next/server";
import { handleInvitation, headResponse } from "@/lib/prospects/report-exchange";

export const dynamic = "force-dynamic";

export async function HEAD(): Promise<Response> {
  return headResponse();
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string; key: string }> }): Promise<Response> {
  const { slug, key } = await params;
  return handleInvitation(request, { credential: key, slugHint: slug });
}
