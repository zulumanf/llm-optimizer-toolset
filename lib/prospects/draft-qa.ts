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
import {
  MISMATCH_TEMPLATE_VERSION,
  MISMATCH_THRESHOLDS,
  OUTREACH_FORBIDDEN_FOOTER_HOST,
  OUTREACH_PUBLIC_WEBSITE,
} from "@/lib/prospects/constants";
import {
  competitiveMismatchReview,
  type MismatchEvidenceSnapshot,
} from "@/lib/prospects/mismatch";

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
  /** Spec 124: the draft's frozen evidence — when present, the body's
   * "N of M" denominators must equal ITS answer count, not the published
   * audit's sample (a mismatch draft counts one provider's answers). */
  evidence?: { denominator: number } | null;
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
  // The public-domain rule (cohort 001 directive): the visible signature
  // block must show the public website, never the operator-console host.
  // Scoped to the footer — a reply-first BODY may legitimately carry an
  // app-hosted audit proof link above the signature.
  const footerStart = body.lastIndexOf("\n—\n");
  const footer = footerStart >= 0 ? body.slice(footerStart) : "";
  if (footer.toLowerCase().includes(OUTREACH_FORBIDDEN_FOOTER_HOST)) {
    add("signature_domain", `signature shows ${OUTREACH_FORBIDDEN_FOOTER_HOST} — the public site is ${OUTREACH_PUBLIC_WEBSITE}.`);
  }
  if (footer && !footer.includes(OUTREACH_PUBLIC_WEBSITE)) {
    add("signature_domain", `signature is missing ${OUTREACH_PUBLIC_WEBSITE}.`);
  }
  if (!input.contactEmail) {
    add("contact", "no contact with an email is bound to the draft.");
  }

  // Two accepted greeting forms: "Hi Name," (reply-first) and the direct
  // "Name —" opener (competitive mismatch, spec 124). Both must greet the
  // bound contact or the team leader.
  const firstLine = body.split("\n", 1)[0] ?? "";
  const greeting =
    body.match(/^Hi ([^,\n]+),/)?.[1] ?? firstLine.match(/^(\S[^—\n]*?)\s+—$/)?.[1];
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

  // Count consistency: one M across the whole email (the 512-vs-354 defect,
  // 2026-08-25), equal to the draft's own evidence denominator when frozen
  // evidence exists (spec 124), else to the published finding's sample.
  const cited = new Set<number>();
  for (const m of body.matchAll(N_OF_M_RE)) cited.add(Number(m[1]));
  for (const m of body.matchAll(MONITORED_RE)) cited.add(Number(m[1]));
  if (cited.size > 1) {
    add("count_consistency", `body cites conflicting sample sizes: ${[...cited].join(", ")}.`);
  }
  if (input.evidence) {
    if (cited.size > 0 && !cited.has(input.evidence.denominator)) {
      add(
        "count_consistency",
        `body cites sample ${[...cited].join(", ")} but the draft's evidence counts ${input.evidence.denominator} answers.`
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
    if (
      !input.evidence &&
      input.audit.sampleSize !== null &&
      cited.size > 0 &&
      !cited.has(input.audit.sampleSize)
    ) {
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

/** Live facts a mismatch draft's frozen claims are re-checked against at
 * approval and again at dispatch (spec 124). */
export interface MismatchQaLive {
  eligible: boolean;
  eligibleCompetitorCompanyIds: string[];
  prospectRecommendationCount: number;
  /** Live count for the snapshot's competitor; null = no longer computable. */
  competitorRecommendationCount: number | null;
  answerCount: number;
  benchmarkAgeDays: number | null;
}

/**
 * Deterministic re-validation of every claim a competitive-mismatch draft
 * makes (spec 124). Pure. Any issue FAILS the draft — approval and the send
 * gate both treat these as refusals, never warnings.
 */
export function qaMismatchClaims(
  body: string,
  snapshot: MismatchEvidenceSnapshot,
  live: MismatchQaLive
): DraftQaIssue[] {
  const issues: DraftQaIssue[] = [];
  const add = (check: string, detail: string): void => {
    issues.push({ check, detail });
  };
  const rendered = [
    `in ${snapshot.prospect.recommendationCount} of ${snapshot.answerCount} answers`,
    `in ${snapshot.competitor.recommendationCount} of ${snapshot.answerCount} answers`,
    snapshot.prospect.productionDisplay,
    snapshot.competitor.productionDisplay,
    snapshot.competitor.name,
  ];
  for (const fragment of rendered) {
    if (!body.includes(fragment)) {
      add("mismatch_render", `body no longer states the frozen claim "${fragment}".`);
    }
  }
  if (live.answerCount !== snapshot.answerCount) {
    add(
      "mismatch_stale",
      `live ${snapshot.provider} answer count is ${live.answerCount}, the draft asserts ${snapshot.answerCount}.`
    );
  }
  if (live.prospectRecommendationCount !== snapshot.prospect.recommendationCount) {
    add(
      "mismatch_stale",
      `live prospect recommendation count is ${live.prospectRecommendationCount}, the draft asserts ${snapshot.prospect.recommendationCount}.`
    );
  }
  if (live.competitorRecommendationCount !== snapshot.competitor.recommendationCount) {
    add(
      "mismatch_stale",
      `live competitor recommendation count is ${live.competitorRecommendationCount ?? "unavailable"}, the draft asserts ${snapshot.competitor.recommendationCount}.`
    );
  }
  if (!live.eligible || !live.eligibleCompetitorCompanyIds.includes(snapshot.competitor.companyId)) {
    add(
      "mismatch_eligibility",
      "the comparison no longer passes eligibility against live data — regenerate the draft."
    );
  }
  if (
    live.benchmarkAgeDays === null ||
    live.benchmarkAgeDays > MISMATCH_THRESHOLDS.maxBenchmarkAgeDays
  ) {
    add(
      "mismatch_recency",
      `benchmark is ${live.benchmarkAgeDays ?? "of unknown"} days old — over the ${MISMATCH_THRESHOLDS.maxBenchmarkAgeDays}-day maximum; refresh the benchmark and regenerate.`
    );
  }
  return issues;
}

/** Assemble a draft's QA input from the database and run the pure core. */
export async function qaDraft(draftId: string): Promise<DraftQaIssue[]> {
  const [row] = await sql`
    select d.subject, d.body, d.prospect_id, d.contact_id,
      d.prompt_version, d.evidence_snapshot,
      p.team_leader, p.brokerage_affiliation,
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
  const snapshot =
    row.promptVersion === MISMATCH_TEMPLATE_VERSION && row.evidenceSnapshot
      ? (row.evidenceSnapshot as MismatchEvidenceSnapshot)
      : null;
  const mismatchIssues: DraftQaIssue[] = [];
  if (snapshot) {
    const review = await competitiveMismatchReview(row.prospectId as string, {
      contactId: (row.contactId as string | null) ?? null,
    });
    const liveCompetitor = review?.evaluation.candidates.find(
      (c) => c.companyId === snapshot.competitor.companyId
    );
    mismatchIssues.push(
      ...qaMismatchClaims((row.body as string) ?? "", snapshot, {
        eligible: review?.evaluation.eligible ?? false,
        eligibleCompetitorCompanyIds:
          review?.evaluation.eligibleCandidates.map((c) => c.companyId) ?? [],
        prospectRecommendationCount: review?.prospect.recommendationCount ?? 0,
        competitorRecommendationCount: liveCompetitor?.recommendationCount ?? null,
        answerCount: review?.benchmark?.answerCount ?? 0,
        benchmarkAgeDays: review?.evaluation.benchmarkAgeDays ?? null,
      })
    );
  }
  return mismatchIssues.concat(qaDraftContent({
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
    evidence: snapshot ? { denominator: snapshot.answerCount } : null,
  }));
}
