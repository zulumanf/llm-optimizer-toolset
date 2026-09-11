"use server";

/**
 * Marketing-site server actions (spec 061). Public by design: this file must
 * never import auth gates or expose anything beyond the audit-request intake.
 */
import { submitAuditRequest, type AuditRequestResult } from "@/lib/marketing/audit-requests";

export type AuditRequestFormState = AuditRequestResult | null;

export async function requestAuditAction(
  _prev: AuditRequestFormState,
  formData: FormData
): Promise<AuditRequestFormState> {
  try {
    return await submitAuditRequest(
      {
        name: formData.get("name"),
        email: formData.get("email"),
        company: formData.get("company"),
        website: formData.get("website"),
        market: formData.get("market"),
        specialization: formData.get("specialization"),
      },
      formData.get("company_phone")
    );
  } catch {
    // A failed write is reported as a failure, never faked as success.
    return {
      ok: false,
      errors: { form: "Something went wrong on our side. Please try again." },
    };
  }
}
