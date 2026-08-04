"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/campaigns/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function createCampaign(input: unknown) {
  return run((u) => svc.createCampaign(u, input));
}
export async function transitionCampaign(input: unknown) {
  return run((u) => svc.transitionCampaign(u, input));
}
export async function addCampaignMember(input: unknown) {
  return run((u) => svc.addCampaignMember(u, input));
}
export async function removeCampaignMember(input: unknown) {
  return run((u) => svc.removeCampaignMember(u, input));
}
