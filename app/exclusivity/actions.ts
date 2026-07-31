"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/exclusivity/service";

async function run<T>(
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    const result = await fn(user);
    if (result.ok) revalidatePath("/exclusivity");
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function createMarket(input: unknown) {
  return run((u) => svc.createMarket(u, input));
}
export async function createAgreement(input: unknown) {
  return run((u) => svc.createAgreement(u, input));
}
export async function terminateAgreement(input: unknown) {
  return run((u) => svc.terminateAgreement(u, input));
}
export async function checkProspect(input: unknown) {
  return run((u) => svc.checkProspect(u, input));
}
