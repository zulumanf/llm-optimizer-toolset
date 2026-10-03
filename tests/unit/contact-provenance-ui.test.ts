/** Spec 148: hand-entered contact provenance defaults safe and is never
 * upgraded by the UI — a send-ready label is always the operator's choice. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTACT_ENTRY_PROVENANCE,
  CONTACT_PROVENANCE_COPY,
  DEFAULT_CONTACT_ENTRY_PROVENANCE,
  EMAIL_CHANGE_PROVENANCE,
  isSendReadyProvenance,
  PROVENANCE_LABELS,
} from "@/lib/prospects/constants";

const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");

describe("contact provenance entry (spec 148)", () => {
  it("defaults are safe: entry and email-change states are not send-ready", () => {
    expect(DEFAULT_CONTACT_ENTRY_PROVENANCE).toBe("manual");
    expect(isSendReadyProvenance(DEFAULT_CONTACT_ENTRY_PROVENANCE)).toBe(false);
    expect(isSendReadyProvenance(EMAIL_CHANGE_PROVENANCE)).toBe(false);
  });

  it("operators choose among exactly manual / publicly sourced / verified — never a guess", () => {
    expect([...CONTACT_ENTRY_PROVENANCE]).toEqual(["manual", "publicly_sourced", "verified"]);
    expect(CONTACT_ENTRY_PROVENANCE).not.toContain("ai_inferred");
    expect(CONTACT_ENTRY_PROVENANCE).not.toContain("estimated");
  });

  it("every label has copy; the copy says which are send-ready and that send-ready requires a real check", () => {
    for (const p of PROVENANCE_LABELS) expect(CONTACT_PROVENANCE_COPY[p].label.length).toBeGreaterThan(0);
    expect(CONTACT_PROVENANCE_COPY.manual.label).toBe("Manual / unverified");
    expect(CONTACT_PROVENANCE_COPY.manual.hint).toMatch(/^Not send-ready/);
    expect(CONTACT_PROVENANCE_COPY.publicly_sourced.hint).toMatch(/^Send-ready\. Choose only if you saw this exact address/);
    expect(CONTACT_PROVENANCE_COPY.verified.hint).toMatch(/^Send-ready\. Choose only if the address was confirmed/);
  });

  it("the contact dialog starts at the safe default, never sets a send-ready label itself, and needs a source for one", () => {
    const src = read("components/prospects/contact-dialog.tsx");
    expect(src).toMatch(/useState<ContactEntryProvenance>\(\s*DEFAULT_CONTACT_ENTRY_PROVENANCE\s*\)/);
    expect(src).not.toMatch(/setProvenance\(\s*["'](verified|publicly_sourced)["']/);
    expect(src).not.toContain("PROVENANCE_LABELS");
    expect(src).toContain("sendReadyIncomplete");
    expect(src).toMatch(/disabled=\{[^}]*sendReadyIncomplete/);
  });

  it("the CSV import labels emails separately and starts them at the safe default", () => {
    const src = read("components/prospects/import-dialog.tsx");
    expect(src).toMatch(/useState<ContactEntryProvenance>\(\s*DEFAULT_CONTACT_ENTRY_PROVENANCE\s*\)/);
    expect(src).not.toMatch(/setEmailProvenance\(\s*["'](verified|publicly_sourced)["']/);
  });

  it("the shared choice component never picks a value on its own", () => {
    const src = read("components/prospects/contact-provenance-choice.tsx");
    expect(src).not.toMatch(/useState|useEffect/);
    expect(src).toContain("onChange(p)");
  });
});
