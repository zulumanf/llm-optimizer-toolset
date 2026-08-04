"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as evidence from "@/lib/evidence/service";
import { generateEvidenceExport as generateExport } from "@/lib/evidence/export";

const run = makeActionRunner(["/projects", "layout"]);

export async function createAuditSample(input: unknown) {
  return run((u) => evidence.createAuditSample(u, input));
}
export async function generateEvidenceExport(input: unknown) {
  return run((u) => generateExport(u, input));
}
export async function createClientValidationRun(input: unknown) {
  return run((u) => evidence.createClientValidationRun(u, input));
}
export async function recordClientValidationObservation(input: unknown) {
  return run((u) => evidence.recordClientValidationObservation(u, input));
}
