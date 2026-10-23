/**
 * Spec 147 §2 — the client-confirmed profile URLs for one project.
 *
 * The only source is the project's live engagement's client-confirmed `asset`
 * context items. URLs are never inferred from page content, other projects or
 * prospect records. Selection is deterministic: rows arrive oldest first, the
 * first row for a normalized URL wins (stable contextItemId), and anything not
 * checked is reported with a reason rather than dropped.
 */
import { confirmedProfileAssetRows, type ConfirmedAssetRow } from "@/db/profile-corrections";
import {
  PROFILE_CHECK_MAX_PROFILES_PER_PROJECT,
  PROFILE_URL_PROTOCOLS,
  PROFILE_URL_SKIP,
  type ProfileUrlSkipReason,
} from "@/lib/profile-corrections/constants";

export interface ConfirmedProfileUrl {
  contextItemId: string;
  profileUrl: string;
}

export interface SkippedProfileUrl {
  contextItemId: string;
  sourceRef: string | null;
  reason: ProfileUrlSkipReason;
}

export interface ConfirmedProfileUrls {
  urls: ConfirmedProfileUrl[];
  skipped: SkippedProfileUrl[];
}

/** An absolute http(s) URL in canonical form, or null. */
export function normalizeProfileUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!(PROFILE_URL_PROTOCOLS as readonly string[]).includes(parsed.protocol)) return null;
  if (parsed.hostname.length === 0) return null;
  // Credentials in a profile URL are never legitimate and must not be fetched.
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.toString();
}

/** Pure selection over rows already scoped to one project (oldest first). */
export function selectConfirmedProfileUrls(
  rows: readonly ConfirmedAssetRow[],
  cap: number = PROFILE_CHECK_MAX_PROFILES_PER_PROJECT
): ConfirmedProfileUrls {
  const urls: ConfirmedProfileUrl[] = [];
  const skipped: SkippedProfileUrl[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const sourceRef = row.sourceRef;
    if (sourceRef === null || sourceRef.trim() === "") {
      skipped.push({ contextItemId: row.id, sourceRef, reason: PROFILE_URL_SKIP.noUrl });
      continue;
    }
    const normalized = normalizeProfileUrl(sourceRef);
    if (normalized === null) {
      skipped.push({ contextItemId: row.id, sourceRef, reason: PROFILE_URL_SKIP.invalidUrl });
      continue;
    }
    if (seen.has(normalized)) {
      skipped.push({ contextItemId: row.id, sourceRef, reason: PROFILE_URL_SKIP.duplicateUrl });
      continue;
    }
    seen.add(normalized);
    if (urls.length >= cap) {
      skipped.push({ contextItemId: row.id, sourceRef, reason: PROFILE_URL_SKIP.overCap });
      continue;
    }
    urls.push({ contextItemId: row.id, profileUrl: normalized });
  }
  return { urls, skipped };
}

export async function listConfirmedProfileUrls(projectId: string): Promise<ConfirmedProfileUrls> {
  return selectConfirmedProfileUrls(await confirmedProfileAssetRows(projectId));
}
