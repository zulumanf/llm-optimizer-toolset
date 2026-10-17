"use server";

import { makeActionRunner } from "@/lib/actions/run";
import * as plan from "@/lib/optimization/plan";
import * as onboarding from "@/lib/onboarding/service";
import * as experiments from "@/lib/experiments/service";

const run = makeActionRunner(["/projects", "layout"]);

export async function buildPlanAction(input: unknown) {
  return run((u) => plan.buildOptimizationPlan(u, input));
}
export async function transitionOpportunityAction(input: unknown) {
  return run((u) => plan.transitionOpportunity(u, input));
}
export async function prepareMeasurementAction(input: unknown) {
  return run((u) => onboarding.prepareMeasurement(u, input));
}
export async function runInitialAnalysisAction(input: unknown) {
  return run((u) => onboarding.runInitialAnalysis(u, input));
}
export async function approvePlanAction(input: unknown) {
  return run((u) => experiments.approvePlan(u, input));
}
