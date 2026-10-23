"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as gold from "@/lib/evaluation/gold";

const run = makeActionRunner(["/evaluation", "layout"]);

export async function createGoldSampleAction(input: unknown) {
  return run((u) => gold.createGoldSample(u, input));
}
export async function recordAnnotationAction(input: unknown) {
  return run((u) => gold.recordAnnotation(u, input));
}
export async function adjudicateItemAction(input: unknown) {
  return run((u) => gold.adjudicateItem(u, input));
}
