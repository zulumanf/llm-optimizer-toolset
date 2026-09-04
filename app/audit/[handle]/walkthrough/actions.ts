"use server";

import { headers } from "next/headers";
import { requestWalkthrough, type WalkthroughResult } from "@/lib/prospects/walkthrough";

/** Anonymous by design: the report token in the form is the credential. */
export async function submitWalkthroughRequest(input: unknown): Promise<WalkthroughResult> {
  const hdrs = await headers();
  return requestWalkthrough(input, {
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
  });
}
