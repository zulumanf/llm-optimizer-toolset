/**
 * Raw source blob storage (spec 021).
 *
 * Files live under `var/knowledge/<projectId>/<sha[0:2]>/<sha>`, content
 * addressed. Two consequences worth stating:
 *
 *  - Identical bytes for one client resolve to the same path, so a retried
 *    upload or a re-run connector sync writes nothing new. Deduplication is a
 *    property of the layout, not a check someone remembered to write.
 *  - The client id is in the path, so two clients holding the same document
 *    hold two independent copies. Deleting one client's data cannot reach
 *    another's, which matters more here than the bytes saved.
 *
 * Shares the write primitive with evidence storage via
 * `lib/storage/content-addressed.ts`.
 */
import { join } from "node:path";
import {
  readStored,
  resolveStoragePath,
  sha256Of,
  writeImmutable,
} from "@/lib/storage/content-addressed";

const KNOWLEDGE_ROOT = join(process.cwd(), "var", "knowledge");

/** Deterministic from (project, content). The sharding keeps directories small. */
export function sourceStorageKey(projectId: string, sha256: string): string {
  return `${projectId}/${sha256.slice(0, 2)}/${sha256}`;
}

export function sourcePath(storageKey: string): string {
  return resolveStoragePath(KNOWLEDGE_ROOT, storageKey);
}

export async function storeSourceBytes(args: {
  projectId: string;
  bytes: Buffer;
}): Promise<{ storageKey: string; sha256: string; alreadyExisted: boolean }> {
  const sha256 = sha256Of(args.bytes);
  const storageKey = sourceStorageKey(args.projectId, sha256);
  const written = await writeImmutable(KNOWLEDGE_ROOT, storageKey, args.bytes);
  return { storageKey, sha256, alreadyExisted: written.alreadyExisted };
}

export async function readSourceBytes(storageKey: string): Promise<Buffer> {
  return readStored(KNOWLEDGE_ROOT, storageKey);
}

export { KNOWLEDGE_ROOT };
