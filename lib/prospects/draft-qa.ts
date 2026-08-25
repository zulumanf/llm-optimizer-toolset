/**
 * Deterministic outreach draft QA (spec 116). Every check here exists
 * because its absence shipped — or nearly shipped — a real defect on
 * 2026-08-25. Pure core (`qaDraftContent`) + a DB assembler (`qaDraft`).
 * Enforced at approval and again inside the send gate; no LLM involved
 * (subjective quality stays with the audit sense-check, spec 077).
 */
import { sql } from "@/db/client";
import { getActiveSenderIdentity } from "@/lib/outreach/sender-identity";
import { auditUrl, brandedAuditUrl } from "@/lib/prospects/urls";

export interface DraftQaIssue {
  check: string;
  detail: string;
}

/** Contact-email domains that identify a brokerage. A prospect contacted at
 * one of these MUST have brokerage_affiliation recorded — the 30-day
 * brokerage recontact cap (spec 052) counts by that column, and a NULL
 * silently exempts the send (found live: two @compass.com prospects with
 * NULL affiliation, 2026-08-25). */
export const BROKERAGE_EMAIL_DOMAINS: Record<string, string> = {
  "compass.com": "Compass",
  "corcoranss.com": "Corcoran Sawyer Smith",
  "redfin.com": "Redfin",
  "cbmoves.com": "Coldwell Banker",
  "coldwellbankermoves.com": "Coldwell Banker",
  "bhsusa.com": "Brown Harris Stevens",
  "kw.com": "Keller Williams",
  "remax.com": "RE/MAX",
  "remax.net": "RE/MAX",
  "longandfoster.com": "Long & Foster",
  "lnf.com": "Long & Foster",
  "exprealty.com": "eXp Realty",
  "exprealty.net": "eXp Realty",
  "serhant.com": "SERHANT.",
  "elliman.com": "Douglas Elliman",
  "sothebysrealty.com": "Sotheby's International Realty",
  "msir.net": "Monument Sotheby's International Realty",
  "psre.com": "Patterson-Schwartz",
};

const ARTIFACT_RE = /\bnull\b|undefined|\{\{|\[object/;
const AUDIT_URL_RE = /https?:\/\/[^\s")]+\/audit\/[^\s")]+/g;
/** "N of M" / "N of the same M" citations and "(K monitored responses)". */
const N_OF_M_RE = /\b\d+\s+of(?:\s+the)?(?:\s+same)?\s+(\d+)\b/g;
const MONITORED_RE = /\((\d+)\s+monitored\s+(?:responses|answers)\)/g;

export interface DraftQaInput {
  subject: string | null;
  body: string;
  contactName: string | null;
  contactEmail: string | null;
  teamLeader: string | null;
  brokerageAffiliation: string | null;
  /** Published-audit facts; null when the prospect has no live audit. */
  audit: {
    sampleSize: number | null;
    preparedByEmail: string | null;
    expiresAt: Date | null;
    /** Every URL that legitimately points at this prospect's audit. */
    validUrls: string[];
  } | null;
  senderReplyTo: string | null;
  senderPostalAddress: string | null;
}

export function qaDraftContent(input: DraftQaInput): DraftQaIssue[] {
  const issues: DraftQaIssue[] = [];
  const add = (check: string, detail: string): void => {
    issues.push({ check, detail });
  };
  const body = input.body ?? "";
  const subject = input.subject ?? "";

  if (ARTIFACT_RE.test(body) || ARTIFACT_RE.test(subject)) {
    add("artifacts", "subject or body contains a template artifact (null/undefined/{{/[object).");
  }
  if (subject.length < 10 || subject.length > 90) {
    add("subject", `subject length ${subject.length} outside 10–90.`);
  }
  if (!body.toLowerCase().includes("unsubscribe")) {
    add("compliance_footer", "body is missing the unsubscribe line.");
  }
  if (input.senderPostalAddress && !body.includes(input.senderPostalAddress)) {
    add("compliance_footer", "body is missing the sender postal address.");
  }
  if (!input.contactEmail) {
    add("contact", "no contact with an email is bound to the draft.");
  }

  const greeting = body.match(/^Hi ([^,]+),/)?.[1];
  if (!greeting) {
    add("greeting", "body does not open with a greeting.");
  } else if (greeting.toLowerCase() !== "there") {
    const names = `${input.contactName ?? ""} ${input.teamLeader ?? ""}`.toLowerCase();
    if (!names.includes(greeting.toLowerCase())) {
      add(
        "greeting",
        `greets "${greeting}" but the bound contact is "${input.contactName ?? "—"}" (team leader "${input.teamLeader ?? "—"}").`
      );
    }
  }

  const urls = body.match(AUDIT_URL_RE) ?? [];
  if (input.audit) {
    for (const u of urls) {
      if (!input.audit.validUrls.includes(u)) {
        add("audit_link", `body links ${u}, which is not this prospect's live audit URL.`);
      }
    }
    if (
      input.audit.expiresAt &&
      input.audit.expiresAt.getTime() < Date.now() + 7 * 86_400_000
    ) {
      add("audit_link", `audit link expires ${input.audit.expiresAt.toISOString().slice(0, 10)} — under 7 days out.`);
    }
    if (input.senderReplyTo && input.audit.preparedByEmail !== input.senderReplyTo) {
      add(
        "prepared_by",
        `audit preparedBy is ${input.audit.preparedByEmail ?? "unset"}, not the sender identity ${input.senderReplyTo}.`
      );
    }
    // Count consistency: one M across the whole email, equal to the
    // published finding's sample (the 512-vs-354 defect, 2026-08-25).
    const cited = new Set<number>();
    for (const m of body.matchAll(N_OF_M_RE)) cited.add(Number(m[1]));
    for (const m of body.matchAll(MONITORED_RE)) cited.add(Number(m[1]));
    if (cited.size > 1) {
      add("count_consistency", `body cites conflicting sample sizes: ${[...cited].join(", ")}.`);
    }
    if (input.audit.sampleSize !== null && cited.size > 0 && !cited.has(input.audit.sampleSize)) {
      add(
        "count_consistency",
        `body cites sample ${[...cited].join(", ")} but the published finding counts ${input.audit.sampleSize}.`
      );
    }
  } else if (urls.length > 0) {
    add("audit_link", "body links an audit but the prospect has no published audit.");
  }

  const domain = input.contactEmail?.split("@")[1]?.toLowerCase();
  if (domain && BROKERAGE_EMAIL_DOMAINS[domain] && !input.brokerageAffiliation?.trim()) {
    add(
      "brokerage_recorded",
      `contact is @${domain} (${BROKERAGE_EMAIL_DOMAINS[domain]}) but the prospect has no brokerage_affiliation — the 30-day brokerage cap cannot see this send.`
    );
  }
  return issues;
}

/** Assemble a draft's QA input from the database and run the pure core. */
export async function qaDraft(draftId: string): Promise<DraftQaIssue[]> {
  const [row] = await sql`
    select d.subject, d.body, p.team_leader, p.brokerage_affiliation,
      c.name as contact_name, c.email as contact_email,
      a.access_token, a.expires_at,
      a.snapshot->'keyFinding'->'metrics'->>'sampleSize' as sample_size,
      a.snapshot->'preparedBy'->>'email' as prepared_by_email,
      al.slug as link_slug, al.key as link_key
    from outreach_drafts d
    join prospects p on p.id = d.prospect_id
    left join prospect_contacts c on c.id = d.contact_id
    left join prospect_audits a on a.prospect_id = p.id and a.status = 'published'
    left join prospect_audit_links al on al.prospect_id = p.id
    where d.id = ${draftId}
  `;
  if (!row) return [{ check: "draft", detail: "draft not found." }];
  const identity = await getActiveSenderIdentity();
  const validUrls: string[] = [];
  if (row.linkSlug && row.linkKey) {
    const u = brandedAuditUrl(row.linkSlug as string, row.linkKey as string);
    if (u) validUrls.push(u);
  }
  if (row.accessToken) {
    const u = auditUrl(row.accessToken as string);
    if (u) validUrls.push(u);
  }
  return qaDraftContent({
    subject: (row.subject as string | null) ?? null,
    body: (row.body as string) ?? "",
    contactName: (row.contactName as string | null) ?? null,
    contactEmail: (row.contactEmail as string | null) ?? null,
    teamLeader: (row.teamLeader as string | null) ?? null,
    brokerageAffiliation: (row.brokerageAffiliation as string | null) ?? null,
    audit: row.accessToken
      ? {
          sampleSize: row.sampleSize !== null ? Number(row.sampleSize) : null,
          preparedByEmail: (row.preparedByEmail as string | null) ?? null,
          expiresAt: row.expiresAt ? new Date(row.expiresAt as Date) : null,
          validUrls,
        }
      : null,
    senderReplyTo: identity?.replyToEmail ?? null,
    senderPostalAddress: identity?.postalAddress ?? null,
  });
}
