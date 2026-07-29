/**
 * Envelope encryption for secrets at rest (AES-256-GCM).
 *
 * Two properties are deliberate:
 *
 *  1. **AAD binds a ciphertext to its owner.** The additional authenticated
 *     data is the owning row's id, so a ciphertext copied from one connection
 *     to another fails to decrypt rather than silently authorising the wrong
 *     account.
 *  2. **No plaintext fallback.** A missing or malformed key fails closed with
 *     a classified error. A system that stores secrets in the clear when
 *     misconfigured is worse than one that refuses to start.
 *
 * `key_version` is stored alongside every ciphertext so a rotation can proceed
 * lazily instead of requiring a stop-the-world re-encryption.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { ClassifiedError } from "@/lib/errors";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

export const CURRENT_KEY_VERSION = 1;

export interface SealedSecret {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: number;
}

function loadKey(version: number): Buffer {
  const raw =
    version === CURRENT_KEY_VERSION
      ? process.env.AUTOMATION_CREDENTIAL_KEY
      : process.env[`AUTOMATION_CREDENTIAL_KEY_V${version}`];
  if (!raw) {
    throw new ClassifiedError(
      "internal",
      `AUTOMATION_CREDENTIAL_KEY${version === CURRENT_KEY_VERSION ? "" : `_V${version}`} is not configured. ` +
        "Connector credentials cannot be read or written without it — generate one with " +
        "`openssl rand -base64 32`."
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new ClassifiedError(
      "internal",
      `AUTOMATION_CREDENTIAL_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}).`
    );
  }
  return key;
}

/** True when a usable key is configured — for health checks and setup UI. */
export function encryptionAvailable(): boolean {
  try {
    loadKey(CURRENT_KEY_VERSION);
    return true;
  } catch {
    return false;
  }
}

export function seal(plaintext: string, aad: string): SealedSecret {
  const key = loadKey(CURRENT_KEY_VERSION);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, authTag: cipher.getAuthTag(), keyVersion: CURRENT_KEY_VERSION };
}

export function open(sealed: SealedSecret, aad: string): string {
  const key = loadKey(sealed.keyVersion);
  const decipher = createDecipheriv(ALGORITHM, key, sealed.iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(sealed.authTag);
  try {
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Deliberately opaque: distinguishing "wrong key" from "wrong owner" from
    // "tampered" would be a decryption oracle.
    throw new ClassifiedError(
      "forbidden",
      "Stored secret could not be decrypted. The key, the owner, or the ciphertext is wrong."
    );
  }
}

/** Constant-time comparison for signature verification. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Compare against itself so the timing profile does not leak the length
    // difference, then return false regardless.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

// -------------------------------------------------------------- redaction

/**
 * Patterns that look like secrets. This is a belt-and-braces measure — the
 * architecture already keeps tokens out of these paths — but a redactor that
 * only handles the cases we remembered is not much of a redactor, so it also
 * strips anything shaped like a long opaque token.
 */
const SECRET_KEY_PATTERN =
  /(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|signature|bearer)/i;
const TOKEN_LIKE = /\b(sk-|pk_|rk_|xox[baprs]-|ghp_|gho_|Bearer\s+)[A-Za-z0-9._\-]{8,}/g;
const LONG_OPAQUE = /\b[A-Za-z0-9_-]{40,}\b/g;

export const REDACTED = "[redacted]";

/** Redact a string: token-shaped substrings become `[redacted]`. */
export function redactString(value: string): string {
  return value.replace(TOKEN_LIKE, REDACTED).replace(LONG_OPAQUE, REDACTED);
}

/**
 * Redact a whole structure. Keys that name a secret are replaced wholesale;
 * string values are scrubbed for token-shaped substrings.
 */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 8) return REDACTED as unknown as T;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    if (Buffer.isBuffer(value)) return REDACTED as unknown as T;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(item, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}
