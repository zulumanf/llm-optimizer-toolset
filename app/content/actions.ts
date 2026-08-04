"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/content/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function createBriefFromFinding(input: unknown) {
  return run((u) => svc.createBriefFromFinding(u, input));
}
export async function generateDraft(input: unknown) {
  return run((u) => svc.generateDraft(u, input));
}
export async function verifyDraft(input: unknown) {
  return run((u) => svc.verifyDraft(u, input));
}
export async function approveAsset(input: unknown) {
  return run((u) => svc.approveAsset(u, input));
}
export async function markPublished(input: unknown) {
  return run((u) => svc.markPublished(u, input));
}
