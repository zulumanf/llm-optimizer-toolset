/**
 * Client self-service onboarding (spec 155) — pure rules. The operator
 * prepares four priorities and the known contacts; the client confirms or
 * corrects them in the portal. Nothing here touches the database.
 */
import { z } from "zod";
import { MIN_VALUE_LABEL_PREFIX } from "@/lib/engagements/constants";

export const CLIENT_ONBOARDING_VERSION = "client-onboarding-v1";

export const ONBOARDING_STATUSES = ["draft", "ready", "completed"] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

/** Stages in which the commercial gate has passed and delivery is live. */
export const ONBOARDING_OPEN_STAGES = ["onboarding", "active"] as const;

export const PRIMARY_FOCUS_OPTIONS = [
  { value: "sellers", label: "Home sellers" },
  { value: "buyers", label: "Home buyers" },
  { value: "buyers_and_sellers", label: "Buyers and sellers" },
] as const;
export type PrimaryFocus = (typeof PRIMARY_FOCUS_OPTIONS)[number]["value"];
const FOCUS_VALUES = PRIMARY_FOCUS_OPTIONS.map((o) => o.value) as [PrimaryFocus, ...PrimaryFocus[]];

export function primaryFocusLabel(v: PrimaryFocus | null): string {
  return PRIMARY_FOCUS_OPTIONS.find((o) => o.value === v)?.label ?? "";
}

export const MAX_PROPERTY_VALUE_USD = 1_000_000_000;
export const ONBOARDING_TEXT_MAX = 200;
export const ONBOARDING_NAME_MAX = 200;
export const ONBOARDING_EMAIL_MAX = 320;

export const prioritiesSchema = z.object({
  primaryFocus: z.enum(FOCUS_VALUES, { message: "Choose who you mainly want to reach." }),
  minPropertyValueUsd: z
    .number({ message: "Enter an amount, like 300,000." })
    .int("Use a whole dollar amount.")
    .positive("Use an amount above zero.")
    .max(MAX_PROPERTY_VALUE_USD, "That amount looks too large.")
    .nullable(),
  additionalOpportunity: z.string().trim().max(ONBOARDING_TEXT_MAX, "Keep this under 200 characters."),
  market: z.string().trim().min(2, "Tell us the area you serve.").max(ONBOARDING_TEXT_MAX, "Keep this under 200 characters."),
});
export type OnboardingPriorities = z.infer<typeof prioritiesSchema>;

/** Operator draft: focus may still be unset while preparing. */
export const preparedPrioritiesSchema = prioritiesSchema.extend({
  primaryFocus: z.enum(FOCUS_VALUES).nullable(),
  market: z.string().trim().max(ONBOARDING_TEXT_MAX),
});
export type PreparedPriorities = z.infer<typeof preparedPrioritiesSchema>;

const optionalEmail = z
  .string()
  .trim()
  .max(ONBOARDING_EMAIL_MAX)
  .refine((v) => v === "" || z.string().email().safeParse(v).success, "Enter a valid email address.");

/** Contacts as stored: empty string = unknown (the client is asked). */
export const contactsSchema = z.object({
  primaryName: z.string().trim().max(ONBOARDING_NAME_MAX),
  primaryEmail: optionalEmail,
  approverIsPrimary: z.boolean(),
  approverName: z.string().trim().max(ONBOARDING_NAME_MAX),
  approverEmail: optionalEmail,
});
export type OnboardingContacts = z.infer<typeof contactsSchema>;

export const EMPTY_CONTACTS: OnboardingContacts = {
  primaryName: "",
  primaryEmail: "",
  approverIsPrimary: false,
  approverName: "",
  approverEmail: "",
};

export const EMPTY_PRIORITIES: PreparedPriorities = {
  primaryFocus: null,
  minPropertyValueUsd: null,
  additionalOpportunity: "",
  market: "",
};

export type ContactField = "primaryName" | "primaryEmail" | "approver";

/** What the client must still supply (only genuinely missing facts). */
export function missingContactFields(c: OnboardingContacts): ContactField[] {
  const missing: ContactField[] = [];
  if (!c.primaryName) missing.push("primaryName");
  if (!c.primaryEmail) missing.push("primaryEmail");
  if (!c.approverIsPrimary && !c.approverName) missing.push("approver");
  return missing;
}

/** A complete, valid contact set or the first plain-English problem. */
export function validateFinalContacts(c: OnboardingContacts): { ok: true } | { ok: false; message: string } {
  const parsed = contactsSchema.safeParse(c);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Please check the details." };
  if (!c.primaryName) return { ok: false, message: "Tell us who we should work with." };
  if (!c.primaryEmail) return { ok: false, message: "Add an email address for your main contact." };
  if (!c.approverIsPrimary && !c.approverName) return { ok: false, message: "Tell us who approves public changes." };
  return { ok: true };
}

/** Operator readiness: what the draft lacks before the client can see it. */
export function preparedMissing(p: PreparedPriorities): string[] {
  const out: string[] = [];
  if (!p.primaryFocus) out.push("primary focus");
  if (p.market.trim().length < 2) out.push("market");
  return out;
}

export type OnboardingStep = "priorities" | "contacts" | "done";

export function onboardingStep(row: { status: OnboardingStatus; prioritiesConfirmedAt: Date | null }): OnboardingStep {
  if (row.status === "completed") return "done";
  return row.prioritiesConfirmedAt ? "contacts" : "priorities";
}

export function effective<T>(prepared: T, client: T | null): T {
  return client ?? prepared;
}

/** Fields the client changed from what we prepared (for the operator). */
export function changedFields<T extends Record<string, unknown>>(prepared: T, client: T | null): (keyof T)[] {
  if (!client) return [];
  return (Object.keys(prepared) as (keyof T)[]).filter((k) => JSON.stringify(prepared[k] ?? null) !== JSON.stringify(client[k] ?? null));
}

export function usd(v: number): string {
  return `$${v.toLocaleString("en-US")}`;
}

/** Read a "$300,000" / "300k" / "1.2m" style entry. Null when unreadable. */
export function parseUsdInput(raw: string): number | null {
  const v = raw.trim().toLowerCase().replace(/[$,\s]/g, "").replace(/usd$/, "");
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(v);
  if (!m) return null;
  const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
  const n = Math.round(Number(m[1]) * mult);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface ContextItemDraft {
  kind: "client_focus" | "priority_area" | "identity";
  label: string;
  provenance: "client_confirmed" | "client_priority";
  value: Record<string, unknown>;
}

export const FOCUS_LABEL_PREFIX = "Primary focus: ";
export const OPPORTUNITY_LABEL_PREFIX = "Additional opportunity: ";
export const MARKET_LABEL_PREFIX = "Market: ";
export const PRIMARY_CONTACT_LABEL_PREFIX = "Primary contact: ";
export const APPROVER_LABEL_PREFIX = "Approver: ";

/**
 * What a completed onboarding records, as client-provenance context. The
 * market is a stated priority only — it never rewrites the engagement's
 * market definition (commercial, exclusivity-bearing).
 */
export function onboardingContextItems(
  p: OnboardingPriorities,
  c: OnboardingContacts,
  engagementMarketName: string
): ContextItemDraft[] {
  const items: ContextItemDraft[] = [
    { kind: "client_focus", label: `${FOCUS_LABEL_PREFIX}${primaryFocusLabel(p.primaryFocus)}`, provenance: "client_priority", value: { primaryFocus: p.primaryFocus, source: CLIENT_ONBOARDING_VERSION } },
  ];
  if (p.minPropertyValueUsd !== null) {
    items.push({ kind: "client_focus", label: `${MIN_VALUE_LABEL_PREFIX}${p.minPropertyValueUsd.toLocaleString("en-US")}`, provenance: "client_confirmed", value: { minPropertyValueUsd: p.minPropertyValueUsd, source: CLIENT_ONBOARDING_VERSION } });
  }
  if (p.additionalOpportunity) {
    items.push({ kind: "client_focus", label: `${OPPORTUNITY_LABEL_PREFIX}${p.additionalOpportunity}`, provenance: "client_priority", value: { segment: p.additionalOpportunity, additionalOpportunity: true, source: CLIENT_ONBOARDING_VERSION } });
  }
  items.push({
    kind: "priority_area",
    label: `${MARKET_LABEL_PREFIX}${p.market}`,
    provenance: "client_priority",
    value: { type: "market", name: p.market, differsFromEngagementMarket: marketDiffers(p.market, engagementMarketName), source: CLIENT_ONBOARDING_VERSION },
  });
  items.push({ kind: "identity", label: `${PRIMARY_CONTACT_LABEL_PREFIX}${c.primaryName}`, provenance: "client_confirmed", value: { role: "primary_contact", name: c.primaryName, email: c.primaryEmail, source: CLIENT_ONBOARDING_VERSION } });
  const approverName = c.approverIsPrimary ? c.primaryName : c.approverName;
  const approverEmail = c.approverIsPrimary ? c.primaryEmail : c.approverEmail;
  items.push({ kind: "identity", label: `${APPROVER_LABEL_PREFIX}${approverName}`, provenance: "client_confirmed", value: { role: "approver", name: approverName, email: approverEmail || null, source: CLIENT_ONBOARDING_VERSION } });
  return items.map((i) => ({ ...i, label: i.label.slice(0, ONBOARDING_TEXT_MAX) }));
}

const normalizeMarket = (s: string) => s.toLowerCase().replace(/\b(area|metro|region|and surrounding|surrounding)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** True when the client's market wording names a different place than the
 * engagement's market (ignoring "area"/"metro" and punctuation). */
export function marketDiffers(clientMarket: string, engagementMarketName: string): boolean {
  const a = normalizeMarket(clientMarket);
  const b = normalizeMarket(engagementMarketName);
  if (!a || !b) return a !== b;
  return !(a.includes(b) || b.includes(a));
}

/** Prefill for the operator's draft from what records already say. */
export function defaultPrimaryFocus(labels: string[]): PrimaryFocus | null {
  const text = labels.join(" ").toLowerCase();
  const sellers = /\bsell(er|ers|ing)?\b|\blisting/.test(text);
  const buyers = /\bbuy(er|ers|ing)?\b/.test(text);
  if (sellers && buyers) return "buyers_and_sellers";
  if (sellers) return "sellers";
  if (buyers) return "buyers";
  return null;
}
