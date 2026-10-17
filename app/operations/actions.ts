"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as econ from "@/lib/economics/service";

const run = makeActionRunner(["/operations", "page"], ["/projects", "layout"]);

export async function recordLaborAction(input: unknown) {
  return run((u) => econ.recordLabor(u, input));
}
export async function recordClientOutcomeAction(input: unknown) {
  return run((u) => econ.recordClientOutcome(u, input));
}
