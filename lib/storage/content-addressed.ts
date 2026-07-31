/**
 * Content-addressed local blob storage — the one place this codebase writes an
 * immutable file to disk.
 *
 * Extracted from `lib/evidence/storage.ts` when spec 021 needed the same
 * primitive for client source material. Two callers, one implementation
 * (CLAUDE.md: no duplicated functions).
 *
 * Two properties matter and both are enforced here rather than by convention:
 *
 *  - **Never overwrite.** `flag: "wx"` makes the write fail if the path exists.
 *    A silent overwrite of stored evidence is the failure this repository
 *    exists to prevent (PRINCIPLES.md #3).
 *  - **Never escape the root.** A storage key is untrusted input; a key
 *    containing `../` would otherwise write anywhere the process can reach.
 *
 * Cloud storage with signed URLs arrives with the Supabase milestone. Until
 * then a single box holds the bytes, which is the honest description of the
 * deployment rather than an abstraction pretending otherwise.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { ClassifiedError } from "@/lib/errors";

/** Resolve a storage key inside `root`, refusing anything that escapes it. */
export function resolveStoragePath(root: string, storageKey: string): string {
  if (storageKey.length === 0) {
    throw new ClassifiedError("validation", "Storage key must not be empty.");
  }
  const path = normalize(join(root, storageKey));
  // The separator check stops `var/evidence-other` passing a bare prefix test.
  if (path !== root && !path.startsWith(root + sep)) {
    throw new ClassifiedError("validation", "Invalid storage key.");
  }
  return path;
}

export function sha256Of(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Write bytes once. Returns the hash and whether the file was already present —
 * a caller deduplicating on content needs to tell "stored" from "already had
 * it", and an exception is the wrong way to say the second one.
 */
export async function writeImmutable(
  root: string,
  storageKey: string,
  bytes: Buffer | Uint8Array
): Promise<{ path: string; sha256: string; alreadyExisted: boolean }> {
  const path = resolveStoragePath(root, storageKey);
  await mkdir(join(path, ".."), { recursive: true });
  const hash = sha256Of(bytes);
  try {
    await writeFile(path, bytes, { flag: "wx" });
    return { path, sha256: hash, alreadyExisted: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { path, sha256: hash, alreadyExisted: true };
    }
    throw err;
  }
}

export async function readStored(root: string, storageKey: string): Promise<Buffer> {
  const path = resolveStoragePath(root, storageKey);
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ClassifiedError("not_found", "Stored artifact is missing from disk.");
    }
    throw err;
  }
}
