import { describe, expect, it } from "vitest";
import {
  isSendReadyProvenance,
  PROVENANCE_LABELS,
  SEND_READY_CONTACT_PROVENANCE,
} from "@/lib/prospects/constants";
import { recipientEmailProvenanceVerdict } from "@/lib/prospects/shared";
import { SEND_READY_CONTACT_PROVENANCE as COHORT_RULE } from "@/lib/prospects/t1-cohort";

describe("recipient provenance (spec 148)", () => {
  it("one canonical rule: the cohort re-exports the same constant", () => {
    expect(COHORT_RULE).toBe(SEND_READY_CONTACT_PROVENANCE);
    expect([...SEND_READY_CONTACT_PROVENANCE].sort()).toEqual(["publicly_sourced", "verified"]);
  });

  it("only verified and publicly_sourced are send-ready; everything else fails closed", () => {
    const ready = PROVENANCE_LABELS.filter((p) => isSendReadyProvenance(p));
    expect(ready.sort()).toEqual(["publicly_sourced", "verified"]);
    for (const p of [null, undefined, "", "pattern_guess", "VERIFIED", "ai_inferred", "manual", "estimated"]) {
      expect(isSendReadyProvenance(p)).toBe(false);
    }
  });

  it("verdict: refuses an ai_inferred / unknown email with the operator instruction", () => {
    const inferred = recipientEmailProvenanceVerdict({ email: "a@b.com", emailProvenance: "ai_inferred" });
    expect(inferred.passed).toBe(false);
    expect(inferred.detail).toContain("Verify this contact before sending");
    expect(inferred.detail).toContain('"ai_inferred"');
    const unknown = recipientEmailProvenanceVerdict({ email: "a@b.com", emailProvenance: null });
    expect(unknown.passed).toBe(false);
    expect(unknown.detail).toContain('"unknown"');
  });

  it("verdict: passes send-ready provenance, and has nothing to judge without an email", () => {
    expect(recipientEmailProvenanceVerdict({ email: "a@b.com", emailProvenance: "verified" }).passed).toBe(true);
    expect(recipientEmailProvenanceVerdict({ email: "a@b.com", emailProvenance: "publicly_sourced" }).passed).toBe(true);
    expect(recipientEmailProvenanceVerdict({ email: null, emailProvenance: null }).passed).toBe(true);
  });
});
