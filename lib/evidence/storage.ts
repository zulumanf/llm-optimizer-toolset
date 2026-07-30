/**
 * Local artifact storage (evidence spec): files live under var/evidence/
 * (gitignored, single-box internal deployment). Every stored file gets a
 * SHA-256 at write time and an immutable evidence_artifacts row. Cloud
 * storage + signed URLs arrive with the Supabase milestone.
 */
import { join } from "node:path";
import { sql } from "@/db/client";
import { ClassifiedError } from "@/lib/errors";
import { resolveStoragePath, writeImmutable } from "@/lib/storage/content-addressed";

const EVIDENCE_ROOT = join(process.cwd(), "var", "evidence");

export function artifactPath(storageKey: string): string {
  return resolveStoragePath(EVIDENCE_ROOT, storageKey);
}

export async function storeArtifact(args: {
  responseId?: string | null;
  kind: "screenshot" | "raw_json" | "html_snapshot" | "video" | "export_file";
  storageKey: string;
  mimeType: string;
  bytes: Buffer | Uint8Array;
  captureMethod: string;
  note?: string;
  createdBy?: string;
}): Promise<{ artifactId: string; sha256: string }> {
  const { sha256, alreadyExisted } = await writeImmutable(
    EVIDENCE_ROOT,
    args.storageKey,
    args.bytes
  );
  if (alreadyExisted) {
    // Evidence keys are unique by construction. A collision means a caller is
    // about to reuse a key that already holds different bytes — refuse loudly
    // rather than let the row and the file disagree.
    throw new ClassifiedError(
      "conflict",
      `An artifact is already stored at "${args.storageKey}".`
    );
  }
  const [row] = await sql`
    insert into evidence_artifacts
      (response_id, kind, storage_key, mime_type, byte_size, sha256,
       capture_method, note, created_by)
    values
      (${args.responseId ?? null}, ${args.kind}, ${args.storageKey},
       ${args.mimeType}, ${args.bytes.length}, ${sha256},
       ${args.captureMethod}, ${args.note ?? null}, ${args.createdBy ?? null})
    returning id
  `;
  return { artifactId: row?.id as string, sha256 };
}

/**
 * Adapter interface for future consumer-interface capture (browser runner).
 * Deliberately interface-only in this spec: a Playwright implementation is
 * its own future spec (credentialed sessions + provider ToS review). See
 * specs/llm-evidence-capture-and-audit-trail.md "Explicitly deferred".
 */
export interface EvidenceCaptureAdapter {
  provider: string;
  captureObservation(args: { promptText: string }): Promise<{
    visibleText: string;
    screenshotPng: Buffer;
    htmlSnapshot?: string;
    sourceLinks: { url: string; title?: string }[];
    sessionMeta: Record<string, string>;
  }>;
}
