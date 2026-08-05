"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as companySvc from "@/lib/companies/service";
import * as reviewSvc from "@/lib/mentions/service";

const runCompanies = makeActionRunner(["/companies", "layout"]);
const runProjects = makeActionRunner(["/projects", "layout"]);

export async function upsertCompany(input: unknown) {
  return runCompanies((u) => companySvc.upsertCompany(u, input));
}

export async function archiveCompany(input: unknown) {
  return runCompanies((u) => companySvc.archiveCompany(u, input));
}

export async function reviewMention(input: unknown) {
  return runProjects((u) => reviewSvc.reviewMention(u, input));
}

export async function bulkConfirmMentions(input: unknown) {
  return runProjects((u) => reviewSvc.bulkConfirmMentions(u, input));
}

export async function reparseRun(input: unknown) {
  return runProjects((u) => reviewSvc.reparseRun(u, input));
}
