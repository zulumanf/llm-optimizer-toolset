/**
 * Spec 147 §7.4 — the deterministic correction email.
 *
 * Every factual line is a quoted, validated statement from the approved
 * correction request: the page's verbatim wording and the approved fact's
 * exact text (with its as-of date). The rest is fixed wording. No model is
 * involved; the model's explanation is not part of the request and so cannot
 * appear here. The recipient is exactly the active destination — never the
 * client's contact unless an operator recorded them as a client_editor.
 *
 * `validateProfileCorrectionEmail` proves an email is byte-identical to this
 * rendering of the approved request for the active destination.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "@/lib/prospects/fact-manifest";
import {
  DESTINATION_KINDS,
  PROFILE_CORRECTION_EMAIL_VERSION,
  PROFILE_RECHECK_DAYS,
} from "@/lib/profile-corrections/constants";
import {
  profileCorrectionRequestHash,
  profileCorrectionRequestSchema,
  type ProfileCorrectionRequest,
} from "@/lib/profile-corrections/request";

export { PROFILE_CORRECTION_EMAIL_VERSION };

// Fixed wording (the only prose not taken from the request).
const SUBJECT_PREFIX = "Correction needed on";
const PAGE_SAYS = "The page says:";
const APPROVED_FACT = "Approved fact:";
const CORRECT_FACT = "Correct fact:";
const AS_OF = "as of";

const editorTemplate = {
  greeting: (name: string) => `Hi ${name},`,
  intro: (url: string) =>
    `We checked ${url} against the facts you approved with us. It currently says something that does not match:`,
  factLabel: APPROVED_FACT,
  closing: [
    "Could you update the page, or reply if the approved fact has changed?",
    `We will check the page again in ${PROFILE_RECHECK_DAYS} days.`,
  ],
};

const publisherTemplate = {
  greeting: (name: string) => `Hello ${name},`,
  intro: (url: string, subject: string) =>
    `We are writing on behalf of ${subject} about ${url}. The page states the following, which does not match ${subject}'s confirmed records:`,
  factLabel: CORRECT_FACT,
  closing: ["Could you please correct the page? Thank you."],
};

export const emailDestinationSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(DESTINATION_KINDS),
  recipientName: z.string().trim().min(1),
  email: z.string().trim().email(),
});
export type EmailDestination = z.infer<typeof emailDestinationSchema>;

export interface CorrectionEmailInput {
  request: ProfileCorrectionRequest;
  requestSha256: string;
  destination: EmailDestination;
  /** The client's recorded name (publisher wording only). */
  subjectName: string;
}

export interface CorrectionEmail {
  templateVersion: typeof PROFILE_CORRECTION_EMAIL_VERSION;
  to: string;
  subject: string;
  body: string;
}

export type EmailRender = { ok: true; email: CorrectionEmail } | { ok: false; errors: string[] };

function quote(text: string): string {
  return `"${text}"`;
}

function itemLines(request: ProfileCorrectionRequest, factLabel: string): string[] {
  // The request's items are already in canonical order (spec 147 §5.4).
  return request.items.flatMap((item, i) => [
    `${i + 1}. ${PAGE_SAYS} ${quote(item.pageWording)}`,
    `   ${factLabel} ${quote(item.approvedStatement)}${item.approvedAsOf ? ` (${AS_OF} ${item.approvedAsOf})` : ""}`,
  ]);
}

export function renderProfileCorrectionEmail(input: CorrectionEmailInput): EmailRender {
  const errors: string[] = [];
  const request = profileCorrectionRequestSchema.safeParse(input.request);
  if (!request.success) errors.push("request: not a valid correction request");
  else if (profileCorrectionRequestHash(request.data) !== input.requestSha256) {
    errors.push("request_hash: the request does not match its approved hash");
  }
  const destination = emailDestinationSchema.safeParse(input.destination);
  if (!destination.success) errors.push("destination: not a valid destination");
  const subjectName = input.subjectName.trim();
  if (destination.success && destination.data.kind === "publisher" && subjectName.length === 0) {
    errors.push("subject_name: a publisher email must name the client");
  }
  if (errors.length > 0 || !request.success || !destination.success) return { ok: false, errors };

  const r = request.data;
  const d = destination.data;
  const host = new URL(r.profileUrl).hostname;
  const lines =
    d.kind === "publisher"
      ? [
          publisherTemplate.greeting(d.recipientName),
          "",
          publisherTemplate.intro(r.profileUrl, subjectName),
          "",
          ...itemLines(r, publisherTemplate.factLabel),
          "",
          ...publisherTemplate.closing,
        ]
      : [
          editorTemplate.greeting(d.recipientName),
          "",
          editorTemplate.intro(r.profileUrl),
          "",
          ...itemLines(r, editorTemplate.factLabel),
          "",
          ...editorTemplate.closing,
        ];
  return {
    ok: true,
    email: {
      templateVersion: PROFILE_CORRECTION_EMAIL_VERSION,
      to: d.email.trim(),
      subject: `${SUBJECT_PREFIX} ${host}`,
      body: lines.join("\n"),
    },
  };
}

/** sha256 of the email's canonical JSON — what the draft row records. */
export function correctionEmailHash(email: CorrectionEmail): string {
  return createHash("sha256").update(canonicalJson(email)).digest("hex");
}

/**
 * The email must be exactly the deterministic rendering of the approved
 * request for the active destination: same recipient, same subject, same
 * body, same template version. Any edit, other recipient or stale hash fails.
 */
export function validateProfileCorrectionEmail(
  candidate: unknown,
  input: CorrectionEmailInput
): { ok: true } | { ok: false; errors: string[] } {
  const rendered = renderProfileCorrectionEmail(input);
  if (!rendered.ok) return rendered;
  const email = rendered.email;
  const c = (candidate ?? {}) as Partial<CorrectionEmail>;
  const errors: string[] = [];
  if (c.templateVersion !== email.templateVersion) errors.push("template_version_mismatch");
  if (c.to !== email.to) errors.push("recipient_mismatch: the email is not addressed to the active destination");
  if (c.subject !== email.subject) errors.push("subject_mismatch");
  if (c.body !== email.body) errors.push("body_mismatch: the body is not the deterministic rendering of the approved request");
  const extra = Object.keys(c).filter((k) => !["templateVersion", "to", "subject", "body"].includes(k));
  if (extra.length > 0) errors.push(`extra_fields: ${extra.join(", ")}`);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
