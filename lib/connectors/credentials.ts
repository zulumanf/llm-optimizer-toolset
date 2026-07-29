/**
 * The credential boundary.
 *
 * This is the ONLY module in the codebase that decrypts a connector secret.
 * Everything else — nodes, agents, server actions, pages, adapters — receives
 * either a call-scoped `secret()` closure (from lib/connectors/execute.ts) or
 * nothing at all. `tests/unit/connector-security.test.ts` asserts the import
 * boundary, so the rule is enforced rather than merely documented.
 *
 * The reason to concentrate it here is simple: "can an agent read a token?" is
 * answerable by reading one file's import list, not by auditing a codebase.
 */
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import * as store from "@/db/connectors";
import { ClassifiedError } from "@/lib/errors";
import { CURRENT_KEY_VERSION, open, seal } from "@/lib/security/envelope";
import type { CredentialKind } from "@/lib/connectors/types";

export interface StoreCredentialInput {
  connectionId: string;
  kind: CredentialKind;
  /** The access token, API key, or signing secret. */
  secret: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  userId: string;
}

/**
 * Encrypt and store a credential. The connection id is the additional
 * authenticated data, so a ciphertext moved to another connection cannot be
 * decrypted — a copied row is a decryption failure, not a privilege escalation.
 */
export async function storeCredential(input: StoreCredentialInput): Promise<void> {
  if (input.secret.trim().length === 0) {
    throw new ClassifiedError("validation", "A credential cannot be empty.");
  }
  const sealed = seal(input.secret, input.connectionId);
  const sealedRefresh =
    input.refreshToken && input.refreshToken.length > 0
      ? seal(input.refreshToken, `${input.connectionId}:refresh`)
      : null;

  await sql.begin(async (tx) => {
    await store.upsertCredential(tx, {
      connectionId: input.connectionId,
      kind: input.kind,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      authTag: sealed.authTag,
      refreshCiphertext: sealedRefresh?.ciphertext ?? null,
      refreshIv: sealedRefresh?.iv ?? null,
      refreshAuthTag: sealedRefresh?.authTag ?? null,
      keyVersion: sealed.keyVersion,
      expiresAt: input.expiresAt ?? null,
    });
    await store.setConnectionStatus(tx, {
      connectionId: input.connectionId,
      status: "active",
      lastError: null,
      expiresAt: input.expiresAt ?? null,
    });
    // The audit row records that a credential was set, never what it was.
    await writeAudit(tx, {
      userId: input.userId,
      action: "connector.credential_stored",
      entity: "connector_connection",
      entityId: input.connectionId,
      detail: {
        kind: input.kind,
        hasRefreshToken: sealedRefresh !== null,
        keyVersion: sealed.keyVersion,
        expiresAt: input.expiresAt?.toISOString() ?? null,
      },
    });
  });
}

export interface ResolvedSecrets {
  kind: CredentialKind;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  keyVersion: number;
}

/**
 * Decrypt a connection's secrets. Internal to the connector layer — exported
 * only so `execute.ts` and `health.ts` can build the call-scoped closure.
 */
export async function resolveSecrets(connectionId: string): Promise<ResolvedSecrets> {
  const material = await store.credentialMaterial(connectionId);
  if (!material) {
    throw new ClassifiedError(
      "forbidden",
      "This connection has no stored credential. Connect the provider before using it."
    );
  }
  const accessToken = open(
    {
      ciphertext: material.ciphertext,
      iv: material.iv,
      authTag: material.authTag,
      keyVersion: material.keyVersion,
    },
    connectionId
  );
  const refreshToken =
    material.refreshCiphertext && material.refreshIv && material.refreshAuthTag
      ? open(
          {
            ciphertext: material.refreshCiphertext,
            iv: material.refreshIv,
            authTag: material.refreshAuthTag,
            keyVersion: material.keyVersion,
          },
          `${connectionId}:refresh`
        )
      : null;

  return {
    kind: material.kind,
    accessToken,
    refreshToken,
    expiresAt: material.expiresAt,
    keyVersion: material.keyVersion,
  };
}

/** True when the stored credential is past (or within a minute of) expiry. */
export function isExpired(secrets: ResolvedSecrets, now: Date = new Date()): boolean {
  if (!secrets.expiresAt) return false;
  return secrets.expiresAt.getTime() - now.getTime() < 60_000;
}

/** Whether a stored credential was written with an older key. */
export function needsRotation(secrets: ResolvedSecrets): boolean {
  return secrets.keyVersion !== CURRENT_KEY_VERSION;
}

/**
 * Re-encrypt an existing credential under the current key. Used by rotation;
 * the plaintext never leaves this module.
 */
export async function rotateCredential(
  connectionId: string,
  userId: string
): Promise<{ rotated: boolean }> {
  const secrets = await resolveSecrets(connectionId);
  if (!needsRotation(secrets)) return { rotated: false };
  await storeCredential({
    connectionId,
    kind: secrets.kind,
    secret: secrets.accessToken,
    refreshToken: secrets.refreshToken,
    expiresAt: secrets.expiresAt,
    userId,
  });
  return { rotated: true };
}

export async function revokeCredential(connectionId: string, userId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await store.revokeConnection(tx, { connectionId, userId });
    await writeAudit(tx, {
      userId,
      action: "connector.revoked",
      entity: "connector_connection",
      entityId: connectionId,
      detail: {},
    });
  });
}
