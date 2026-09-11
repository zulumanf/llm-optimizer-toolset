/**
 * The server-action runner (cleanup audit 2026-08-04, B1): this 12-line
 * helper existed as 12 byte-identical copies plus 3 near-copies across the
 * app action modules. One factory, parameterized on the revalidate targets —
 * the one axis the copies actually varied on. A wrong default here would
 * silently break cache invalidation, so there is no default: every module
 * states its targets.
 */
import { revalidatePath } from "next/cache";
import { getCurrentUser, type CurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";

/** A path, optionally with the revalidation type revalidatePath accepts. */
export type RevalidateTarget = string | [string, "layout" | "page"];

/**
 * A target computed from the successful result's data — for actions whose
 * cache path embeds the created row's id (cleanup 2026-08-18; this is why
 * app/projects/actions.ts carried a private copy of the runner). Always
 * returns a LIST of targets, so a tuple target is never ambiguous with it.
 */
export type DynamicTargets = (data: unknown) => RevalidateTarget[];

export function makeActionRunner(
  ...targets: (RevalidateTarget | DynamicTargets)[]
) {
  return async function run<T>(
    fn: (user: CurrentUser) => Promise<ActionResult<T>>
  ): Promise<ActionResult<T>> {
    try {
      const user = await getCurrentUser();
      const result = await fn(user);
      if (result.ok) {
        for (const target of targets) {
          const resolved =
            typeof target === "function" ? target(result.data) : [target];
          for (const entry of resolved) {
            if (typeof entry === "string") revalidatePath(entry);
            else revalidatePath(entry[0], entry[1]);
          }
        }
      }
      return result;
    } catch (err) {
      return fail(err);
    }
  };
}
