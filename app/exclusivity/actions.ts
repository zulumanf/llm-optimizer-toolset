"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as svc from "@/lib/exclusivity/service";

const run = makeActionRunner("/exclusivity");

export async function createMarket(input: unknown) {
  return run((u) => svc.createMarket(u, input));
}
export async function createAgreement(input: unknown) {
  return run((u) => svc.createAgreement(u, input));
}
export async function terminateAgreement(input: unknown) {
  return run((u) => svc.terminateAgreement(u, input));
}
export async function checkProspect(input: unknown) {
  return run((u) => svc.checkProspect(u, input));
}
