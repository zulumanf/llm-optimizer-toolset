"use server";

import { revalidatePath } from "next/cache";
import { sql } from "@/db/client";
import { assertProjectAccess, assertRole, getCurrentUser } from "@/lib/auth";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { ClassifiedError } from "@/lib/errors";
import { generateExecutiveBrief } from "@/lib/reports/executive";

/** Previous full calendar month / quarter in UTC — an executive brief over
 * a period still in flight would fail the gate's completeness check anyway;
 * computing the window here keeps the service pure about time. */
function previousPeriod(kind: "monthly" | "quarterly", now: Date): {
  periodStart: string;
  periodEnd: string;
} {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  if (kind === "monthly") {
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    return {
      periodStart: start.toISOString().slice(0, 10),
      periodEnd: end.toISOString().slice(0, 10),
    };
  }
  const quarter = Math.floor(month / 3);
  const start = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const end = new Date(Date.UTC(year, quarter * 3, 0));
  return {
    periodStart: start.toISOString().slice(0, 10),
    periodEnd: end.toISOString().slice(0, 10),
  };
}

export async function generateBrief(input: {
  projectId: string;
  kind: "monthly" | "quarterly";
}): Promise<ActionResult<{ briefId: string | null; gateOutcome: string }>> {
  try {
    const user = await getCurrentUser();
    assertRole(user, "operator");
    await assertProjectAccess(user, input.projectId);
    if (input.kind !== "monthly" && input.kind !== "quarterly") {
      return fail(new ClassifiedError("validation", "Unknown brief kind."));
    }
    const period = previousPeriod(input.kind, new Date());
    const result = await sql.begin((tx) =>
      generateExecutiveBrief(
        tx,
        { projectId: input.projectId, ...period },
        input.kind
      )
    );
    revalidatePath("/control-tower");
    if (result.gate.outcome !== "pass") {
      return fail(
        new ClassifiedError(
          "conflict",
          `Gate refused the brief: ${result.gate.reason}. An ungated brief is exactly the artifact that gets retracted.`
        )
      );
    }
    return ok({
      briefId: result.briefId,
      gateOutcome: result.gate.outcome,
    });
  } catch (err) {
    return fail(err);
  }
}

export async function acknowledgeDrift(input: unknown) {
  // Was the one action in the app with no try/catch (an auth failure
  // escaped as an unhandled rejection) and with dynamic re-imports of
  // modules already imported at the top of this file (cleanup 2026-08-18).
  try {
    const user = await getCurrentUser();
    const { acknowledgeDriftSignal } = await import("@/lib/drift/detect");
    const result = await acknowledgeDriftSignal(user, input);
    if (result.ok) revalidatePath("/control-tower");
    return result;
  } catch (err) {
    return fail(err);
  }
}
