import "server-only";
import { z } from "zod";
import { insertAuditRequest } from "@/db/audit-requests";
import {
  AUDIT_REQUEST_FIELD_MAX,
  AUDIT_REQUEST_EMAIL_MAX,
} from "@/lib/marketing/constants";

/**
 * Audit-request intake (spec 061). This is the platform's only anonymous
 * mutation, so it is deliberately narrow: bounded fields, one insert-only
 * table, and a honeypot that swallows bot submissions without a tell.
 * No auth gate by design — the exception is documented in the spec, like
 * the audit page's token route.
 */

const optionalField = z
  .string()
  .trim()
  .max(AUDIT_REQUEST_FIELD_MAX, "Too long")
  .transform((v) => (v === "" ? null : v));

const auditRequestSchema = z.object({
  name: z.string().trim().min(1, "Required").max(AUDIT_REQUEST_FIELD_MAX, "Too long"),
  email: z
    .string()
    .trim()
    .min(1, "Required")
    .max(AUDIT_REQUEST_EMAIL_MAX, "Too long")
    .email("Enter a valid email"),
  company: optionalField,
  website: optionalField,
  market: z
    .string()
    .trim()
    .min(1, "Required")
    .max(AUDIT_REQUEST_FIELD_MAX, "Too long"),
  specialization: optionalField,
});

export type AuditRequestResult =
  | { ok: true }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate and store a request. `honeypot` is the hidden field's value: bots
 * fill it, humans cannot see it. A tripped honeypot reports success without
 * writing — an error message would teach the bot what happened.
 */
export async function submitAuditRequest(
  fields: Record<string, unknown>,
  honeypot: unknown
): Promise<AuditRequestResult> {
  if (typeof honeypot === "string" && honeypot.trim() !== "") {
    return { ok: true };
  }
  const parsed = auditRequestSchema.safeParse(fields);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === "string" && !(key in errors)) errors[key] = issue.message;
    }
    return { ok: false, errors };
  }
  await insertAuditRequest(parsed.data);
  return { ok: true };
}
