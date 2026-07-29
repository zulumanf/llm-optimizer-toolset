/**
 * Local artifact storage (evidence spec): files live under var/evidence/
 * (gitignored, single-box internal deployment). Every stored file gets a
 * SHA-256 at write time and an immutable evidence_artifacts row. Cloud
 * storage + signed URLs arrive with the Supabase milestone.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { sql } from "@/db/client";
import { ClassifiedError } from "@/lib/errors";

const EVIDENCE_ROOT = join(process.cwd(), "var", "evidence");

export function artifactPath(storageKey: string): string {
  const path = normalize(join(EVIDENCE_ROOT, storageKey));
  if (!path.startsWith(EVIDENCE_ROOT)) {
    throw new ClassifiedError("validation", "Invalid storage key.");
  }
  return path;
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
  const path = artifactPath(args.storageKey);
  await mkdir(join(path, ".."), { recursive: true });
  const sha256 = createHash("sha256").update(args.bytes).digest("hex");
  await writeFile(path, args.bytes, { flag: "wx" }); // never overwrite
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
