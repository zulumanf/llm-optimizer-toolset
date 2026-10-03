"use client";

import {
  CONTACT_ENTRY_PROVENANCE,
  CONTACT_PROVENANCE_COPY,
  type ContactEntryProvenance,
} from "@/lib/prospects/constants";

/** The one way an operator labels an email address by hand. The caller owns
 * the state and must start it at DEFAULT_CONTACT_ENTRY_PROVENANCE; this
 * component never picks a send-ready label on its own. */
export function ContactProvenanceChoice({
  name,
  legend,
  value,
  onChange,
}: {
  name: string;
  legend: string;
  value: ContactEntryProvenance;
  onChange: (next: ContactEntryProvenance) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{legend}</legend>
      <p className="text-xs text-muted-foreground">
        Outreach only goes to publicly sourced or verified addresses. Pick one of those only if
        you actually checked the address yourself — never for a guess or a pattern.
      </p>
      <div className="space-y-1.5">
        {CONTACT_ENTRY_PROVENANCE.map((p) => (
          <label
            key={p}
            className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
          >
            <input
              type="radio"
              name={name}
              value={p}
              checked={value === p}
              onChange={() => onChange(p)}
              className="mt-0.5"
            />
            <span>
              <span className="font-medium">{CONTACT_PROVENANCE_COPY[p].label}</span>
              <span className="block text-xs text-muted-foreground">
                {CONTACT_PROVENANCE_COPY[p].hint}
              </span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
