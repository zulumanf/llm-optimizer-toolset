"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/learnings/service";

const run = makeActionRunner(["/learnings", "page"]);

export async function recordLearningAction(input: unknown) {
  return run((u) => svc.recordLearning(u, input));
}
export async function retireLearningAction(input: unknown) {
  return run((u) => svc.retireLearning(u, input));
}
