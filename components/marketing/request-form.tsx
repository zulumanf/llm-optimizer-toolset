"use client";

/**
 * Audit request form (spec 061, brief §31). Short by design: low-friction
 * entry, qualification happens in the review that follows. The confirmation
 * copy is honest about the manual process — no fake instant analysis.
 */
import { useActionState } from "react";
import { requestAuditAction, type AuditRequestFormState } from "@/app/(marketing)/actions";

const INPUT_CLASSES =
  "w-full rounded-md border bg-transparent px-3 py-2 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Field({
  label,
  name,
  type = "text",
  required,
  autoComplete,
  error,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  autoComplete?: string;
  error?: string;
}) {
  const errorId = error ? `${name}-error` : undefined;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`request-${name}`} className="text-sm font-medium">
        {label}
        {!required && <span className="text-muted-foreground"> (optional)</span>}
      </label>
      <input
        id={`request-${name}`}
        name={name}
        type={type}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={INPUT_CLASSES}
      />
      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function RequestForm() {
  const [state, formAction, isPending] = useActionState<AuditRequestFormState, FormData>(
    requestAuditAction,
    null
  );

  if (state?.ok) {
    return (
      <div className="max-w-xl rounded-lg border p-6" role="status">
        <p className="text-sm font-medium">Request received.</p>
        <p className="mt-2 text-sm text-muted-foreground">
          We&apos;ll review your market and determine whether there is enough
          evidence to produce a meaningful analysis. If there is, you&apos;ll hear
          from a person, not an automation.
        </p>
      </div>
    );
  }

  const errors = state && !state.ok ? state.errors : {};

  return (
    <form action={formAction} className="max-w-xl">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" name="name" required autoComplete="name" error={errors.name} />
        <Field
          label="Work email"
          name="email"
          type="email"
          required
          autoComplete="email"
          error={errors.email}
        />
        <Field
          label="Team / company"
          name="company"
          autoComplete="organization"
          error={errors.company}
        />
        <Field label="Website" name="website" autoComplete="url" error={errors.website} />
        <Field
          label="Primary market"
          name="market"
          required
          error={errors.market}
        />
        <Field
          label="Primary specialization"
          name="specialization"
          error={errors.specialization}
        />
      </div>
      {/* Honeypot: hidden from people, filled by bots. Server drops it silently. */}
      <div className="sr-only" aria-hidden="true">
        <label htmlFor="request-company_phone">Company phone</label>
        <input
          id="request-company_phone"
          name="company_phone"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>
      {errors.form && (
        <p className="mt-4 text-sm text-destructive" role="alert">
          {errors.form}
        </p>
      )}
      <button
        type="submit"
        disabled={isPending}
        className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
      >
        {isPending ? "Submitting…" : "Analyze my visibility"}
      </button>
      <p className="mt-3 max-w-[60ch] text-xs text-muted-foreground">
        Requests are reviewed by a person before any analysis. We don&apos;t sell
        submitted information or use it to manufacture ranking claims.
      </p>
    </form>
  );
}
