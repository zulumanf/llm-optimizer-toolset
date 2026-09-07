/**
 * Legacy front door (spec 076/032, exchanged by spec 134): /audit/<slug>/<key>.
 * The credential validates exactly as before, then rides the same exchange
 * as a new invitation and lands on the clean /report/<slug> URL — every
 * link already emailed keeps working.
 */
import type { NextRequest } from "next/server";
import { handleInvitation, headResponse } from "@/lib/prospects/report-exchange";

export const dynamic = "force-dynamic";

export async function HEAD(): Promise<Response> {
  return headResponse();
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ handle: string; key?: string }> }): Promise<Response> {
  const p = await params;
  return handleInvitation(request, { credential: p.key ?? "", slugHint: p.handle, next: null });
}
