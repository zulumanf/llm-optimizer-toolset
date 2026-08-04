"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/plans/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function composePlan(input: unknown) {
  return run((u) => svc.composePlan(u, input));
}
export async function approvePlan(input: unknown) {
  return run((u) => svc.approvePlan(u, input));
}
export async function activatePlanItem(input: unknown) {
  return run((u) => svc.activatePlanItem(u, input));
}
export async function dropPlanItem(input: unknown) {
  return run((u) => svc.dropPlanItem(u, input));
}
