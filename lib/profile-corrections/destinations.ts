/**
 * Spec 147 §7.3 — correction destinations, recorded by an operator.
 *
 * A destination is never inferred from the page's domain and never defaulted
 * to the client's contact. Setting one archives the previous active row and
 * inserts a new one (history is never rewritten), then — in the same
 * transaction, under the profile's lock — routes every request that follows
 * this profile's destination again. That is how a `destination_required`
 * request resumes, how a replaced destination re-routes a waiting request,
 * and how archiving one sends its requests back to `destination_required`.
 */
import { z } from "zod";
import { sql, type TransactionSql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import {
  activeDestination,
  archiveDestinationRow,
  clientConfirmedContact,
  destinationById,
  hasCorrectionForUrl,
  insertDestination,
  lockProfileDestination,
  reroutableCorrections,
  type DestinationRow,
} from "@/db/profile-corrections";
import { fail, ok, type ActionResult } from "@/lib/actions/result";
import { assertProjectAccess, assertRole, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { firstZodMessage } from "@/lib/service-helpers";
import { DESTINATION_KINDS, REROUTABLE_CORRECTION_STATUSES } from "@/lib/profile-corrections/constants";
import { routeCorrectionInTx, type RouteResult } from "@/lib/profile-corrections/routing";
import { listConfirmedProfileUrls, normalizeProfileUrl } from "@/lib/profile-corrections/urls";

const REPLACED_REASON = "replaced by a new destination";
const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_TEXT = 2000;

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL");

/** Validated operator input for one destination. */
export const destinationInputSchema = z
  .object({
    projectId: z.string().uuid(),
    profileUrl: httpUrl,
    kind: z.enum(DESTINATION_KINDS),
    recipientName: z.string().trim().min(1).max(MAX_NAME),
    email: z.string().trim().toLowerCase().email().max(MAX_EMAIL),
    basis: z.string().trim().min(3).max(MAX_TEXT),
    sourceUrl: httpUrl.nullish(),
  })
  .strict()
  .refine((d) => d.kind !== "publisher" || Boolean(d.sourceUrl), {
    message: "A publisher destination needs the URL where its corrections address was found.",
    path: ["sourceUrl"],
  });

export type DestinationInput = z.infer<typeof destinationInputSchema>;

export interface DestinationChange {
  destination: DestinationRow | null;
  archived: string | null;
  routed: RouteResult[];
}

async function authorize(user: CurrentUser, projectId: string): Promise<void> {
  assertRole(user, "operator");
  await assertProjectAccess(user, projectId);
}

/**
 * A destination may only be recorded for this project's own profile: one of
 * its client-confirmed URLs, or a URL it already has a correction for.
 */
async function assertProjectProfile(projectId: string, profileUrl: string): Promise<void> {
  const { urls } = await listConfirmedProfileUrls(projectId);
  if (urls.some((u) => u.profileUrl === profileUrl)) return;
  if (await hasCorrectionForUrl(sql, projectId, profileUrl)) return;
  throw new ClassifiedError("not_found", "That profile URL is not one of this client's profiles.");
}

/** Route again every request that follows this profile's destination. */
async function rerouteProfile(
  tx: TransactionSql,
  projectId: string,
  profileUrl: string,
  actorId: string
): Promise<RouteResult[]> {
  const rows = await reroutableCorrections(tx, projectId, profileUrl, REROUTABLE_CORRECTION_STATUSES);
  const results: RouteResult[] = [];
  for (const row of rows) results.push(await routeCorrectionInTx(tx, row, actorId));
  return results;
}

export async function setCorrectionDestination(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<DestinationChange>> {
  const parsed = destinationInputSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    await authorize(user, input.projectId);
    const profileUrl = normalizeProfileUrl(input.profileUrl);
    if (!profileUrl) throw new ClassifiedError("validation", "The profile URL is not a valid http(s) URL.");
    await assertProjectProfile(input.projectId, profileUrl);

    const change = await sql.begin(async (tx) => {
      await lockProfileDestination(tx, input.projectId, profileUrl);
      const previous = await activeDestination(tx, input.projectId, profileUrl, { lock: true });
      if (previous) {
        await archiveDestinationRow(tx, previous.id, {
          projectId: input.projectId,
          archivedBy: user.id,
          reason: REPLACED_REASON,
        });
      }
      const destination = await insertDestination(tx, {
        projectId: input.projectId,
        profileUrl,
        kind: input.kind,
        recipientName: input.recipientName,
        email: input.email,
        basis: input.basis,
        sourceUrl: input.sourceUrl ?? null,
        createdBy: user.id,
      });
      await writeAudit(tx, {
        userId: user.id,
        action: "profile_correction_destination.set",
        entity: "profile_correction_destination",
        entityId: destination.id,
        projectId: input.projectId,
        detail: { profileUrl, kind: destination.kind, replaced: previous?.id ?? null },
      });
      const routed = await rerouteProfile(tx, input.projectId, profileUrl, user.id);
      return { destination, archived: previous?.id ?? null, routed };
    });
    return ok(change);
  } catch (err) {
    return fail(err);
  }
}

const archiveSchema = z.object({
  projectId: z.string().uuid(),
  destinationId: z.string().uuid(),
  reason: z.string().trim().min(3).max(MAX_TEXT),
});

export async function archiveCorrectionDestination(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<DestinationChange>> {
  const parsed = archiveSchema.safeParse(raw);
  if (!parsed.success) return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  const input = parsed.data;
  try {
    await authorize(user, input.projectId);
    const existing = await destinationById(sql, input.destinationId);
    if (!existing || existing.projectId !== input.projectId) {
      throw new ClassifiedError("not_found", "Destination not found.");
    }
    const change = await sql.begin(async (tx) => {
      await lockProfileDestination(tx, existing.projectId, existing.profileUrl);
      const archived = await archiveDestinationRow(tx, existing.id, {
        projectId: input.projectId,
        archivedBy: user.id,
        reason: input.reason,
      });
      if (!archived) throw new ClassifiedError("conflict", "That destination is already archived.");
      await writeAudit(tx, {
        userId: user.id,
        action: "profile_correction_destination.archived",
        entity: "profile_correction_destination",
        entityId: existing.id,
        projectId: existing.projectId,
        detail: { profileUrl: existing.profileUrl, reason: input.reason },
      });
      const routed = await rerouteProfile(tx, existing.projectId, existing.profileUrl, user.id);
      return { destination: null, archived: existing.id, routed };
    });
    return ok(change);
  } catch (err) {
    return fail(err);
  }
}

/**
 * The client's confirmed contact as a CANDIDATE for a client_editor
 * destination. Only an operator choosing it (and saying why) turns it into a
 * destination; routing never reads it.
 */
export async function clientEditorPrefill(
  user: CurrentUser,
  projectId: string
): Promise<ActionResult<{ kind: "client_editor"; recipientName: string; email: string } | null>> {
  try {
    await authorize(user, projectId);
    const contact = await clientConfirmedContact(projectId);
    return ok(contact ? { kind: "client_editor", recipientName: contact.name, email: contact.email } : null);
  } catch (err) {
    return fail(err);
  }
}
