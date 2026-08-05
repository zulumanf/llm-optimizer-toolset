/**
 * The deterministic field-mapping layer.
 *
 * `applyMapping` is a pure function over a stored, approved mapping version.
 * There is no code path, no expression language and no LLM in it — the
 * transforms are a closed enum. That is the "no arbitrary executable code in
 * nodes" rule applied to data, and it is what makes a client's CRM import
 * reproducible a year later.
 *
 * An LLM MAY propose a mapping during onboarding. The proposal is stored with
 * `suggested_by_agent` and cannot be used until a human sets `approved_by` —
 * `applyMapping` refuses a non-approved version outright.
 */
import { z } from "zod";
import { ClassifiedError } from "@/lib/errors";

export const MAPPING_TRANSFORMS = [
  "none",
  "trim",
  "lowercase",
  "uppercase",
  "normalize_email",
  "normalize_phone",
  "normalize_url",
  "parse_number",
  "parse_currency",
  "parse_date",
  "boolean",
] as const;
export type MappingTransform = (typeof MAPPING_TRANSFORMS)[number];

export const MAPPING_VALIDATIONS = [
  "none",
  "email",
  "phone",
  "url",
  "non_negative",
  "iso_date",
] as const;
export type MappingValidation = (typeof MAPPING_VALIDATIONS)[number];

export const mappingFieldSchema = z.object({
  sourceField: z.string().min(1),
  destinationField: z.string().min(1),
  dataType: z.enum(["string", "number", "boolean", "date", "currency"]).default("string"),
  required: z.boolean().default(false),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.null()]).default(null),
  transform: z.enum(MAPPING_TRANSFORMS).default("none"),
  validation: z.enum(MAPPING_VALIDATIONS).default("none"),
});
export type MappingField = z.infer<typeof mappingFieldSchema>;

export interface MappingVersion {
  definitionId: string;
  version: number;
  status: "proposed" | "approved" | "deprecated";
  fields: MappingField[];
  suggestedByAgent: string | null;
  approvedBy: string | null;
}

// ------------------------------------------------------------- normalisers

/**
 * Email normalisation for MATCHING, not for sending. Plus-tags are stripped so
 * a suppression on `x@y.com` also catches `x+campaign@y.com` — deliverability
 * uses the original address, suppression uses this.
 */
export function normalizeEmailForMatching(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = local.indexOf("+");
  return `${plus === -1 ? local : local.slice(0, plus)}@${domain}`;
}

/** Lowercase and trim, keeping the plus-tag. Used for storage and sending. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * E.164-ish normalisation. Keeps a leading `+`, strips separators, and assumes
 * a bare 10-digit number is North American — documented rather than silent,
 * because that assumption is wrong outside NANP.
 */
export function normalizePhone(value: string, defaultCountryCode = "1"): string {
  const digits = value.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  const bare = digits.replace(/^0+/, "");
  if (bare.length === 10) return `+${defaultCountryCode}${bare}`;
  if (bare.length === 11 && bare.startsWith(defaultCountryCode)) return `+${bare}`;
  return bare.length > 0 ? `+${bare}` : "";
}

/** Canonical URL: lowercase host, no default port, no trailing slash, no hash. */
export function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    if (
      (url.protocol === "https:" && url.port === "443") ||
      (url.protocol === "http:" && url.port === "80")
    ) {
      url.port = "";
    }
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.hostname}${path}${url.search}`;
  } catch {
    return trimmed.toLowerCase();
  }
}

/** Registrable-ish domain, for domain-level suppression. */
export function normalizeDomain(value: string): string {
  const url = normalizeUrl(value);
  try {
    return new URL(url).hostname;
  } catch {
    return value.trim().toLowerCase().replace(/^www\./, "");
  }
}

/** Currency string → integer cents. Never floats: see lib/connectors/adapters/crm. */
export function parseCurrencyToCents(value: string): number | null {
  const cleaned = value.replace(/[^0-9.,\-]/g, "");
  if (cleaned.length === 0) return null;
  // Treat the last separator as the decimal point when it has 1-2 trailing digits.
  const normalized = /[.,]\d{1,2}$/.test(cleaned)
    ? cleaned.replace(/[.,](?=.*[.,])/g, "").replace(",", ".")
    : cleaned.replace(/[.,]/g, "");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

// -------------------------------------------------------------- application

export interface MappingResult {
  ok: boolean;
  record: Record<string, unknown>;
  errors: string[];
  /** Source keys the mapping did not cover — surfaced, never dropped silently. */
  unmappedSourceFields: string[];
}

function applyTransform(
  raw: unknown,
  transform: MappingTransform
): { value: unknown; error: string | null } {
  if (raw === null || raw === undefined) return { value: null, error: null };
  const text = String(raw);
  switch (transform) {
    case "none":
      return { value: raw, error: null };
    case "trim":
      return { value: text.trim(), error: null };
    case "lowercase":
      return { value: text.trim().toLowerCase(), error: null };
    case "uppercase":
      return { value: text.trim().toUpperCase(), error: null };
    case "normalize_email":
      return { value: normalizeEmail(text), error: null };
    case "normalize_phone":
      return { value: normalizePhone(text), error: null };
    case "normalize_url":
      return { value: normalizeUrl(text), error: null };
    case "parse_number": {
      const numeric = Number(text.replace(/[^0-9.\-]/g, ""));
      return Number.isFinite(numeric)
        ? { value: numeric, error: null }
        : { value: null, error: `"${text}" is not a number` };
    }
    case "parse_currency": {
      const cents = parseCurrencyToCents(text);
      return cents === null
        ? { value: null, error: `"${text}" is not a currency amount` }
        : { value: cents, error: null };
    }
    case "parse_date": {
      const parsed = Date.parse(text);
      return Number.isFinite(parsed)
        ? { value: new Date(parsed).toISOString(), error: null }
        : { value: null, error: `"${text}" is not a date` };
    }
    case "boolean": {
      const truthy = ["true", "yes", "y", "1", "on"];
      const falsy = ["false", "no", "n", "0", "off", ""];
      const lowered = text.trim().toLowerCase();
      if (truthy.includes(lowered)) return { value: true, error: null };
      if (falsy.includes(lowered)) return { value: false, error: null };
      return { value: null, error: `"${text}" is not a boolean` };
    }
    default: {
      const _exhaustive: never = transform;
      void _exhaustive;
      return { value: null, error: `unknown transform` };
    }
  }
}

function validateValue(
  value: unknown,
  validation: MappingValidation
): string | null {
  if (value === null || value === undefined) return null;
  switch (validation) {
    case "none":
      return null;
    case "email":
      return /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(String(value)) ? null : "not a valid email";
    case "phone":
      return /^\+?\d{7,15}$/.test(String(value)) ? null : "not a valid phone number";
    case "url":
      return /^https?:\/\/[^\s]+$/.test(String(value)) ? null : "not a valid URL";
    case "non_negative":
      return typeof value === "number" && value >= 0 ? null : "must be zero or greater";
    case "iso_date":
      return Number.isFinite(Date.parse(String(value))) ? null : "not a valid date";
    default: {
      const _exhaustive: never = validation;
      void _exhaustive;
      return "unknown validation";
    }
  }
}

/**
 * Map one external record into the canonical model.
 *
 * Refuses a non-approved mapping version. That refusal is the enforcement point
 * for "an LLM may suggest, only a human approves".
 */
export function applyMapping(
  version: MappingVersion,
  source: Record<string, unknown>
): MappingResult {
  if (version.status !== "approved") {
    throw new ClassifiedError(
      "forbidden",
      `Mapping version ${version.version} is "${version.status}". Only an approved mapping may be applied` +
        (version.suggestedByAgent
          ? ` — this one was suggested by ${version.suggestedByAgent} and still needs human approval.`
          : ".")
    );
  }

  const record: Record<string, unknown> = {};
  const errors: string[] = [];
  const usedSourceFields = new Set<string>();

  for (const field of version.fields) {
    usedSourceFields.add(field.sourceField);
    const raw = source[field.sourceField];
    const present = raw !== undefined && raw !== null && String(raw).length > 0;

    if (!present) {
      if (field.required && field.defaultValue === null) {
        errors.push(`${field.destinationField}: required source field "${field.sourceField}" is missing`);
        continue;
      }
      record[field.destinationField] = field.defaultValue;
      continue;
    }

    const transformed = applyTransform(raw, field.transform);
    if (transformed.error) {
      errors.push(`${field.destinationField}: ${transformed.error}`);
      continue;
    }
    const validationError = validateValue(transformed.value, field.validation);
    if (validationError) {
      errors.push(`${field.destinationField}: ${validationError}`);
      continue;
    }
    record[field.destinationField] = transformed.value;
  }

  return {
    ok: errors.length === 0,
    record,
    errors,
    unmappedSourceFields: Object.keys(source).filter((key) => !usedSourceFields.has(key)),
  };
}

/** Map a batch, reporting per-row failures rather than aborting the batch. */
export function applyMappingBatch(
  version: MappingVersion,
  rows: Record<string, unknown>[]
): {
  mapped: Record<string, unknown>[];
  failures: { index: number; errors: string[] }[];
  unmappedSourceFields: string[];
} {
  const mapped: Record<string, unknown>[] = [];
  const failures: { index: number; errors: string[] }[] = [];
  const unmapped = new Set<string>();

  rows.forEach((row, index) => {
    const result = applyMapping(version, row);
    for (const field of result.unmappedSourceFields) unmapped.add(field);
    if (result.ok) mapped.push(result.record);
    else failures.push({ index, errors: result.errors });
  });

  return { mapped, failures, unmappedSourceFields: [...unmapped] };
}
