"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser } from "@/lib/auth";
import { fail, type ActionResult } from "@/lib/actions/result";
import {
  onboardClient as onboard,
  type OnboardingResult,
} from "@/lib/verticals/onboarding";
import { expandPack } from "@/lib/verticals/expand";
import { findPack } from "@/lib/verticals/packs";

export async function onboardClient(
  input: unknown
): Promise<ActionResult<OnboardingResult>> {
  try {
    const user = await getCurrentUser();
    const result = await onboard(user, input);
    if (result.ok) revalidatePath("/projects", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

/** Live preview of the prompts a pack + variables would generate, so the
 * operator sees the benchmark before committing to it. */
export async function previewPrompts(input: {
  packKey: string;
  variables: Record<string, string[]>;
  brand: string;
  competitors: string[];
}): Promise<{ text: string; category: string; tier: number; isHoldout: boolean }[]> {
  const pack = findPack(input.packKey);
  if (!pack) return [];
  return expandPack({
    pack,
    variables: input.variables,
    brand: input.brand || "the client",
    competitors: input.competitors,
  });
}
