/**
 * Request-side helpers for the private report surface (spec 134). The only
 * place the session cookie is read or written; the lib layer
 * (report-access.ts) never touches next/headers.
 */
import { cookies, headers } from "next/headers";
import {
  authorizeReportRequest,
  presentedTokensFromCookies,
  sessionCookieName,
  sessionTtlDays,
  type ReportSession,
} from "@/lib/prospects/report-access";

/** Cookie values presented for this slug — one per report, but a browser
 * may hold several rfr_* cookies whose paths prefix-match this slug. */
export async function presentedSessionTokens(slug: string): Promise<string[]> {
  return presentedTokensFromCookies((await cookies()).getAll(), slug);
}

/** The authorized session for this slug, or null. */
export async function readReportSession(slug: string): Promise<ReportSession | null> {
  return authorizeReportRequest(slug, await presentedSessionTokens(slug));
}

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  referrer: string | null;
}

export async function requestMeta(): Promise<RequestMeta> {
  const hdrs = await headers();
  return {
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent"),
    referrer: hdrs.get("referer"),
  };
}

/** Set-Cookie attributes for a report session: HttpOnly, Secure in
 * production, Lax (an emailed-link navigation must carry it), scoped to the
 * report's own path, explicit expiry. */
export function sessionCookieOptions(slug: string): {
  name: string;
  httpOnly: true;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
} {
  return {
    name: sessionCookieName(slug),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: `/report/${slug}`,
    maxAge: sessionTtlDays() * 24 * 60 * 60,
  };
}
