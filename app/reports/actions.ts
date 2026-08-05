"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/reports/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function generateReportDraft(input: unknown) {
  return run((u) => svc.generateReportDraft(u, input));
}
export async function updateReportNarrative(input: unknown) {
  return run((u) => svc.updateReportNarrative(u, input));
}
export async function regenerateReportDraft(input: unknown) {
  return run((u) => svc.regenerateReportDraft(u, input));
}
export async function publishReport(input: unknown) {
  return run((u) => svc.publishReport(u, input));
}
export async function deleteDraft(input: unknown) {
  return run((u) => svc.deleteDraft(u, input));
}
