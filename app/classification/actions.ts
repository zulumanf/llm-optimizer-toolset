"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as companySvc from "@/lib/companies/service";
import * as reviewSvc from "@/lib/mentions/service";

async function run<T>(
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<T>>,
  paths: string[]
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    const result = await fn(user);
    if (result.ok) for (const p of paths) revalidatePath(p, "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function upsertCompany(input: unknown) {
  return run((u) => companySvc.upsertCompany(u, input), ["/companies"]);
}

export async function archiveCompany(input: unknown) {
  return run((u) => companySvc.archiveCompany(u, input), ["/companies"]);
}

export async function reviewMention(input: unknown) {
  return run((u) => reviewSvc.reviewMention(u, input), ["/projects"]);
}

export async function bulkConfirmMentions(input: unknown) {
  return run((u) => reviewSvc.bulkConfirmMentions(u, input), ["/projects"]);
}

export async function reparseRun(input: unknown) {
  return run((u) => reviewSvc.reparseRun(u, input), ["/projects"]);
}
