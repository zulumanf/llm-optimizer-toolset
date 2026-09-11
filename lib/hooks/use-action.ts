"use client";

/**
 * The one client-side action idiom (cleanup 2026-08-18): useTransition +
 * sonner toast + optional router.refresh(). This existed inline in a dozen
 * buttons; the only axes they varied on were the success message (sometimes
 * computed from the action's data) and whether the page refreshes after.
 *
 * Client-safe by construction: the result type is structural, so this file
 * imports nothing from the server side.
 */
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

/** Structurally compatible with ActionResult<T> from lib/actions/result. */
type ActionOutcome<T> =
  | { ok: true; data: T }
  | { ok: false; error?: { message: string } };

export interface UseActionOptions<T> {
  /** Success toast — a string, or computed from the action's data. */
  success?: string | ((data: T) => string);
  /** Fallback error toast when the action returns no message. */
  error?: string;
  /** Call router.refresh() after a successful action. */
  refresh?: boolean;
}

export function useAction(): {
  pending: boolean;
  run: <T>(
    fn: () => Promise<ActionOutcome<T>>,
    opts?: UseActionOptions<T>
  ) => void;
} {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const run = <T,>(
    fn: () => Promise<ActionOutcome<T>>,
    opts?: UseActionOptions<T>
  ): void => {
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        if (opts?.success !== undefined) {
          toast.success(
            typeof opts.success === "function"
              ? opts.success(result.data)
              : opts.success
          );
        }
        if (opts?.refresh) router.refresh();
      } else {
        toast.error(
          result.error?.message ?? opts?.error ?? "Something went wrong."
        );
      }
    });
  };

  return { pending, run };
}
