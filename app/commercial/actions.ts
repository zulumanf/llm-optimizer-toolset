"use server";

/**
 * Commercial path actions (spec 140): quote → agreement → invoices → payment
 * → onboarding intake. One module because the same buttons appear on the
 * prospect page and the client engagement page; both trees revalidate.
 */
import { makeActionRunner } from "@/lib/actions/run";
import * as quotes from "@/lib/pricing/quotes";
import * as agreements from "@/lib/engagements/agreement";
import * as commercial from "@/lib/engagements/commercial";
import * as intake from "@/lib/engagements/onboarding-intake";
import * as engagements from "@/lib/engagements/service";

const run = makeActionRunner(["/prospects", "layout"], ["/projects", "layout"], "/");

export async function prepareQuote(input: unknown) {
  return run((u) => quotes.prepareQuote(u, input));
}
export async function markQuotePresented(input: unknown) {
  return run((u) => quotes.markQuotePresented(u, input));
}
export async function regenerateDraftQuote(input: unknown) {
  return run((u) => quotes.regenerateDraftQuote(u, input));
}
export async function recordQuoteOutcome(input: unknown) {
  return run((u) => quotes.recordQuoteOutcome(u, input));
}
export async function signClientFromQuote(input: unknown) {
  return run((u) => engagements.signClient(u, input));
}
export async function confirmMarketDefinition(input: unknown) {
  return run((u) => engagements.confirmMarketDefinition(u, input));
}
export async function prepareAgreement(input: unknown) {
  return run((u) => agreements.prepareAgreement(u, input));
}
export async function markAgreementSent(input: unknown) {
  return run((u) => agreements.markAgreementSent(u, input));
}
export async function recordAgreementSigned(input: unknown) {
  return run((u) => agreements.recordAgreementSigned(u, input));
}
export async function voidAgreement(input: unknown) {
  return run((u) => agreements.voidAgreement(u, input));
}
export async function createInvoiceSchedule(input: unknown) {
  return run((u) => commercial.createInvoiceSchedule(u, input));
}
export async function recordInstallmentPayment(input: unknown) {
  return run((u) => commercial.recordInstallmentPayment(u, input));
}
export async function startOnboarding(input: unknown) {
  return run((u) => engagements.startOnboarding(u, input));
}
export async function completeOnboardingIntake(input: unknown) {
  return run((u) => intake.completeOnboardingIntake(u, input));
}
export async function activateExclusivity(input: unknown) {
  return run((u) => engagements.activateExclusivity(u, input));
}
export async function markActive(input: unknown) {
  return run((u) => engagements.markActive(u, input));
}
