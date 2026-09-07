/**
 * Wire contract of the audit engagement beacon (spec 098) — shared by the
 * public route and its tests. Route files may only export handlers.
 */
import { z } from "zod";

export const ENGAGEMENT_EVENT_KINDS = [
  "engaged_time",
  "scroll",
  "section_viewed",
  "evidence_expanded",
  "cta_clicked",
] as const;

/** Hard ceilings: one beacon carries at most this many events; engaged time
 * above a day is noise; the body is a few hundred bytes at most. */
const MAX_EVENTS_PER_BEACON = 20;
const MAX_ENGAGED_SECONDS = 86_400;
export const MAX_BODY_BYTES = 8_192;

const ID = z.string().trim().min(8).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const beaconSchema = z.object({
  viewId: z.string().uuid(),
  sessionId: ID,
  visitorId: ID.nullable().optional(),
  events: z
    .array(
      z.object({
        kind: z.enum(ENGAGEMENT_EVENT_KINDS),
        value: z.number().int().min(0).max(MAX_ENGAGED_SECONDS).nullable().optional(),
        target: z.string().trim().max(40).regex(/^[a-z0-9_-]+$/).nullable().optional(),
      })
    )
    .min(1)
    .max(MAX_EVENTS_PER_BEACON),
});

