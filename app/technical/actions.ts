"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/discoverability/service";

/** Thin wrappers (docs/11): identity + revalidation around the
 * discoverability service. */
const run = makeActionRunner(["/projects", "layout"]);

export async function requestTechnicalScan(input: unknown) {
  return run((u) => svc.requestTechnicalScan(u, input));
}
export async function createTaskFromSiteFinding(input: unknown) {
  return run((u) => svc.createTaskFromSiteFinding(u, input));
}
export async function dismissSiteFinding(input: unknown) {
  return run((u) => svc.dismissSiteFinding(u, input));
}
export async function reopenSiteFinding(input: unknown) {
  return run((u) => svc.reopenSiteFinding(u, input));
}
