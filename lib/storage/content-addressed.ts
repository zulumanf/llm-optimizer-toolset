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
 * Durability (release 151): with `ARTIFACT_STORE=s3` every write is also
 * uploaded (write-once, sha-checked) to S3-compatible object storage BEFORE
 * the call returns, and `ensureLocal` fetches a missing file back from it.
 * The local directory is then a per-container cache, so the web and worker
 * services (separate containers) and every redeploy see the same bytes.
 * Without it, the local directory is the only copy (development).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join, normalize, sep } from "node:path";
import { ClassifiedError } from "@/lib/errors";
import { getObject, objectStoreEnabled, putObjectOnce } from "@/lib/storage/object-store";

/** Object key for a stored file: the root's name (evidence, knowledge,
 * video-assets) plus the storage key — stable across containers. */
export function objectKeyFor(root: string, storageKey: string): string {
  return `${basename(root)}/${storageKey}`;
}

/** Upload a file already written under root (e.g. a tar produced by a CLI). */
export async function mirrorStoredFile(root: string, storageKey: string): Promise<void> {
  if (!objectStoreEnabled()) return;
  const bytes = await readFile(resolveStoragePath(root, storageKey));
  await putObjectOnce(objectKeyFor(root, storageKey), bytes, sha256Of(bytes));
}

/**
 * The local path of a stored file, fetching it from the object store when
 * this container does not have it (another service wrote it, or the
 * container was redeployed). Throws not_found when it exists nowhere.
 */
export async function ensureLocal(root: string, storageKey: string): Promise<string> {
  const path = resolveStoragePath(root, storageKey);
  if (existsSync(path)) return path;
  if (!objectStoreEnabled()) {
    throw new ClassifiedError("not_found", "Stored artifact is missing from disk.");
  }
  const bytes = await getObject(objectKeyFor(root, storageKey));
  if (!bytes) throw new ClassifiedError("not_found", "Stored artifact is missing from disk and object storage.");
  await mkdir(join(path, ".."), { recursive: true });
  const tmp = `${path}.part-${process.pid}-${Date.now()}`;
  await writeFile(tmp, bytes, { flag: "wx" });
  await rename(tmp, path);
  return path;
}

/** Like ensureLocal, but null instead of throwing when absent everywhere. */
export async function ensureLocalIfStored(root: string, storageKey: string): Promise<string | null> {
  try {
    return await ensureLocal(root, storageKey);
  } catch (err) {
    if (err instanceof ClassifiedError && err.kind === "not_found") return null;
    throw err;
  }
}

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
  let alreadyExisted = false;
  if (objectStoreEnabled()) {
    // Durable first: the object store is the source of truth. Different
    // bytes already stored under this key are a conflict (thrown before any
    // local write); the same bytes stored by another container count as
    // "already existed", exactly as a local hit would.
    const upload = await putObjectOnce(objectKeyFor(root, storageKey), Buffer.from(bytes), hash);
    if (upload === "already_present") alreadyExisted = true;
  }
  try {
    await writeFile(path, bytes, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    alreadyExisted = true;
  }
  return { path, sha256: hash, alreadyExisted };
}

export async function readStored(root: string, storageKey: string): Promise<Buffer> {
  const path = await ensureLocal(root, storageKey);
  try {
    return await readFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ClassifiedError("not_found", "Stored artifact is missing from disk.");
    }
    throw err;
  }
}
