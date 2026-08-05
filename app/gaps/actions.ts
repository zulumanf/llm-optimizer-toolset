"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/gaps/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function analyzeRun(input: unknown) {
  return run((u) => svc.analyzeRun(u, input));
}
export async function createTaskFromFinding(input: unknown) {
  return run((u) => svc.createTaskFromFinding(u, input));
}
export async function dismissFinding(input: unknown) {
  return run((u) => svc.dismissFinding(u, input));
}
export async function reopenFinding(input: unknown) {
  return run((u) => svc.reopenFinding(u, input));
}
