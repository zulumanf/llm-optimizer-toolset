"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/competitors/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function addCompetitor(input: unknown) {
  return run((u) => svc.addCompetitor(u, input));
}
export async function updateCompetitorTier(input: unknown) {
  return run((u) => svc.updateCompetitorTier(u, input));
}
export async function archiveCompetitor(input: unknown) {
  return run((u) => svc.archiveCompetitor(u, input));
}
export async function trackBrandCandidate(input: unknown) {
  return run((u) => svc.trackBrandCandidate(u, input));
}
export async function dismissBrandCandidate(input: unknown) {
  return run((u) => svc.dismissBrandCandidate(u, input));
}
