/**
 * Artifact-integrity verification (evidence spec): recompute every hash in
 * SQL — the same canonicalization the capture trigger used — and report any
 * row whose stored hash no longer matches. Zero mismatches is the expected
 * steady state; any mismatch means out-of-band tampering or corruption.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { sql } from "@/db/client";
import { artifactPath } from "@/lib/evidence/storage";

export interface IntegrityReport {
  checkedResponses: number;
  mismatchedResponses: { responseId: string; field: "response" | "payload" }[];
  checkedArtifacts: number;
  mismatchedArtifacts: { artifactId: string; reason: string }[];
}

export async function verifyRunIntegrity(runId: string): Promise<IntegrityReport> {
  const mismatched = await sql`
    select id,
      (response_hash is distinct from
        encode(sha256(convert_to(coalesce(response_text, ''), 'UTF8')), 'hex'))
        as text_mismatch,
      (payload_hash is distinct from case when raw_payload is null then null
        else encode(sha256(convert_to(raw_payload::text, 'UTF8')), 'hex') end)
        as payload_mismatch
    from responses where run_id = ${runId}
  `;
  const mismatchedResponses: IntegrityReport["mismatchedResponses"] = [];
  for (const row of mismatched) {
    if (row.textMismatch) {
      mismatchedResponses.push({ responseId: row.id as string, field: "response" });
    }
    if (row.payloadMismatch) {
      mismatchedResponses.push({ responseId: row.id as string, field: "payload" });
    }
  }

  const artifacts = await sql`
    select a.id, a.storage_key, a.sha256 from evidence_artifacts a
    left join responses r on r.id = a.response_id
    where r.run_id = ${runId} or a.response_id is null
  `;
  const mismatchedArtifacts: IntegrityReport["mismatchedArtifacts"] = [];
  for (const artifact of artifacts) {
    try {
      const bytes = await readFile(artifactPath(artifact.storageKey as string));
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (hash !== artifact.sha256) {
        mismatchedArtifacts.push({
          artifactId: artifact.id as string,
          reason: "sha256 mismatch",
        });
      }
    } catch {
      mismatchedArtifacts.push({
        artifactId: artifact.id as string,
        reason: "file missing or unreadable",
      });
    }
  }

  return {
    checkedResponses: mismatched.length,
    mismatchedResponses,
    checkedArtifacts: artifacts.length,
    mismatchedArtifacts,
  };
}
