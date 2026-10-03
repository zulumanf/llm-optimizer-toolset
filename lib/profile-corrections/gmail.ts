/**
 * Spec 147 slice 4 — the Gmail preconditions for creating a correction draft.
 *
 * The draft is created through the existing `email.create_draft` capability on
 * the Gmail adapter, which uses the connection's `sendAsAddress` as the From
 * address (the workflow never supplies one). So a draft attempt needs an
 * ACTIVE Gmail connection for this client (or the platform) that names a
 * valid sendAsAddress. Anything else fails the attempt before Gmail is called.
 */
import { z } from "zod";
import { connectionFor } from "@/db/connectors";
import { PROFILE_DRAFT_PROVIDER } from "@/lib/profile-corrections/constants";

const ACTIVE_CONNECTION = "active";
const sendAs = z.string().trim().email();

export type DraftConnection =
  | { ok: true; connectionId: string; fromAddress: string }
  | { ok: false; reason: string };

export async function draftConnection(projectId: string): Promise<DraftConnection> {
  const connection = await connectionFor({ projectId, provider: PROFILE_DRAFT_PROVIDER });
  if (!connection) {
    return { ok: false, reason: "no Gmail connection exists for this client; connect Gmail before drafting" };
  }
  if (connection.status !== ACTIVE_CONNECTION) {
    return { ok: false, reason: `the Gmail connection is ${connection.status}, not active` };
  }
  const from = sendAs.safeParse(connection.config.sendAsAddress);
  if (!from.success) {
    return { ok: false, reason: "the Gmail connection has no valid sendAsAddress; set it before drafting" };
  }
  return { ok: true, connectionId: connection.id, fromAddress: from.data };
}
