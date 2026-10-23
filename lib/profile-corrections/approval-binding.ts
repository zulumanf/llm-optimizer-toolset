/**
 * Spec 147 §7: an approval is bound to the exact request a human saw.
 *
 * The approval gate stores what it showed in `workflow_approvals.detail`
 * (`output.artifact`, the verify_correction output). This check proves that
 * the shown request hashes to the hash shown beside it, and that both equal
 * the stored request's hash. Any edit — to the stored row, the shown artifact
 * or the hash — breaks the binding, so a changed request can never inherit an
 * approval given for another one. Pure.
 */
import { profileCorrectionRequestHash } from "@/lib/profile-corrections/request";

function obj(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function approvalBindingError(detail: unknown, storedRequestSha256: string): string | null {
  const artifact = obj(obj(obj(detail)?.output)?.artifact);
  if (!artifact || artifact.request === undefined) {
    return "the approval does not carry the correction request it approved";
  }
  const shownHash = artifact.requestSha256;
  const actualHash = profileCorrectionRequestHash(artifact.request);
  if (shownHash !== actualHash) {
    return "the approved request does not match the hash shown with it";
  }
  if (actualHash !== storedRequestSha256) {
    return `the approval was given for request ${actualHash}, but the stored request is ${storedRequestSha256}`;
  }
  return null;
}

/**
 * The external-submission approval binds to the request hash AND the exact
 * destination shown. A request routed to a different destination since can
 * never be submitted under this approval.
 */
export function externalApprovalBindingError(
  detail: unknown,
  storedRequestSha256: string,
  storedDestinationId: string | null
): string | null {
  const contentError = approvalBindingError(detail, storedRequestSha256);
  if (contentError) return contentError;
  const artifact = obj(obj(obj(detail)?.output)?.artifact);
  const destination = obj(artifact?.destination);
  if (!destination || typeof destination.id !== "string") {
    return "the external-submission approval does not name the destination it approved";
  }
  if (destination.id !== storedDestinationId) {
    return `the external submission was approved for destination ${destination.id}, but the request is now routed to ${String(storedDestinationId)}`;
  }
  return null;
}

/**
 * The send confirmation binds to the request, its hash, the destination and
 * the exact Gmail draft shown. A confirmation for any other draft, request
 * version or recipient can never mark this request sent.
 */
export function sendConfirmationBindingError(
  detail: unknown,
  expected: {
    correctionRequestId: string;
    requestSha256: string;
    destinationId: string | null;
    draftAttemptId: string;
    gmailDraftId: string | null;
  }
): string | null {
  const artifact = obj(obj(obj(detail)?.output)?.artifact);
  if (!artifact) return "the confirmation does not carry the draft it confirmed";
  const checks: [string, unknown, unknown][] = [
    ["request", artifact.correctionRequestId, expected.correctionRequestId],
    ["request hash", artifact.requestSha256, expected.requestSha256],
    ["destination", artifact.destinationId, expected.destinationId],
    ["draft attempt", artifact.draftAttemptId, expected.draftAttemptId],
    ["Gmail draft", artifact.gmailDraftId, expected.gmailDraftId],
  ];
  for (const [label, shown, current] of checks) {
    if (shown === undefined || shown === null || shown !== current) {
      return `the confirmation was given for another ${label} (${String(shown)}), not ${String(current)}`;
    }
  }
  return null;
}
