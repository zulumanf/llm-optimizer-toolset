"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/citations/service";

const run = makeActionRunner(["/projects/[id]/citations", "page"]);

export async function discoverOpportunitiesAction(input: unknown) {
  return run((u) => svc.discoverOpportunities(u, input));
}
export async function updateOpportunityAction(input: unknown) {
  return run((u) => svc.updateOpportunity(u, input));
}
export async function requestPresenceCheckAction(input: unknown) {
  return run((u) => svc.requestPresenceCheck(u, input));
}
export async function linkPlacementAction(input: unknown) {
  return run((u) => svc.linkPlacement(u, input));
}
