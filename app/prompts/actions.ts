"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import * as setService from "@/lib/prompts/set-service";
import * as promptService from "@/lib/prompts/prompt-service";
import * as importService from "@/lib/prompts/import";
import * as marketGenerate from "@/lib/markets/generate";
import * as marketInstall from "@/lib/markets/install";

/**
 * Thin wrappers: identity + revalidation around lib/prompts services
 * (docs/11: logic in lib, actions at the boundary). Revalidation is
 * layout-wide — prompt pages all live under /projects.
 */
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

export async function createPromptSet(input: unknown) {
  return run((u) => setService.createPromptSet(u, input));
}
export async function updatePromptSet(input: unknown) {
  return run((u) => setService.updatePromptSet(u, input));
}
export async function archivePromptSet(input: unknown) {
  return run((u) => setService.archivePromptSet(u, input));
}
export async function freezePromptSet(input: unknown) {
  return run((u) => setService.freezePromptSet(u, input));
}
export async function duplicatePromptSet(input: unknown) {
  return run((u) => setService.duplicatePromptSet(u, input));
}
export async function addPrompt(input: unknown) {
  return run((u) => promptService.addPrompt(u, input));
}
export async function updatePrompt(input: unknown) {
  return run((u) => promptService.updatePrompt(u, input));
}
export async function archivePrompt(input: unknown) {
  return run((u) => promptService.archivePrompt(u, input));
}
export async function reorderPrompts(input: unknown) {
  return run((u) => promptService.reorderPrompts(u, input));
}
export async function importPrompts(input: unknown) {
  return run((u) => importService.importPrompts(u, input));
}
export async function generateMarketPrompts(input: unknown) {
  return run((u) => marketGenerate.generateMarketPrompts(u, input));
}
export async function installMarketPack(input: unknown) {
  return run((u) => marketInstall.installMarketPack(u, input));
}
