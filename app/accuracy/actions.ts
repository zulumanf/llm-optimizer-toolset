"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/accuracy/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function analyzeRunAccuracy(input: unknown) {
  return run((u) => svc.analyzeRunAccuracy(u, input));
}
export async function setFindingStatus(input: unknown) {
  return run((u) => svc.setFindingStatus(u, input));
}
export async function createCorrectionTask(input: unknown) {
  return run((u) => svc.createCorrectionTask(u, input));
}
