"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/campaigns/service";

async function run<T>(
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    const result = await fn(user);
    if (result.ok) revalidatePath("/projects", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function createCampaign(input: unknown) {
  return run((u) => svc.createCampaign(u, input));
}
export async function transitionCampaign(input: unknown) {
  return run((u) => svc.transitionCampaign(u, input));
}
export async function addCampaignMember(input: unknown) {
  return run((u) => svc.addCampaignMember(u, input));
}
export async function removeCampaignMember(input: unknown) {
  return run((u) => svc.removeCampaignMember(u, input));
}
