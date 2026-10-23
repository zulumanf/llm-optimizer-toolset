"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as orgs from "@/lib/organizations/service";

const run = makeActionRunner(["/organizations", "layout"]);

export async function createOrganizationAction(input: unknown) {
  return run((u) => orgs.createOrganization(u, input));
}
export async function addOrganizationEntityAction(input: unknown) {
  return run((u) => orgs.addOrganizationEntity(u, input));
}
export async function grantOrganizationAccessAction(input: unknown) {
  return run((u) => orgs.grantOrganizationAccess(u, input));
}
