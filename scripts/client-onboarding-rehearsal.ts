/**
 * Spec 155 — prepare and share the client's self-service onboarding on the
 * SYNTHETIC "pending client" seeded by scripts/client-delivery-rehearsal.ts,
 * using Medina-like draft values (clearly labelled synthetic). Local sandbox
 * only; sends nothing.
 *
 *   DATABASE_URL=postgres://localhost:5433/<sandbox> AUTH_MODE=dev \
 *     npx tsx --tsconfig tsconfig.json scripts/client-onboarding-rehearsal.ts <pendingProjectId> [display name]
 */
const url = process.env.DATABASE_URL ?? "";
const parsed = (() => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
})();
if (!parsed || !["localhost", "127.0.0.1"].includes(parsed.hostname) || !/(sandbox|demo|rehearsal|test|e2e)/.test(parsed.pathname)) {
  console.error("Refusing: DATABASE_URL must be a LOCAL sandbox database.");
  process.exit(1);
}

async function main() {
  const projectId = process.argv[2];
  if (!projectId) throw new Error("usage: client-onboarding-rehearsal.ts <projectId>");
  const { sql } = await import("@/db/client");
  const { DEV_USER_ID } = await import("@/lib/auth");
  const eng = await import("@/lib/engagements/service");
  const onb = await import("@/lib/engagements/client-onboarding");
  const op = { id: DEV_USER_ID, email: "dev@avos.local", name: "Rehearsal Operator", role: "admin" as const };
  const e = await eng.engagementForProject(projectId);
  if (!e) throw new Error("no engagement on that project");
  const displayName = process.argv[3] ?? "Medina Real Estate (synthetic)";
  await sql`update companies set name = ${displayName} where id = (select subject_company_id from projects where id = ${projectId})`;
  const defaults = (await onb.onboardingDefaults(e.id))!;
  const r = await onb.prepareClientOnboarding(op, {
    engagementId: e.id,
    priorities: { primaryFocus: "sellers", minPropertyValueUsd: 300_000, additionalOpportunity: "Luxury listings", market: "Albuquerque area" },
    contacts: { ...defaults.contacts, approverName: "", approverEmail: "", approverIsPrimary: false },
  });
  if (!r.ok) throw new Error(r.error.message);
  const ready = await onb.markOnboardingReady(op, { engagementId: e.id });
  if (!ready.ok) throw new Error(ready.error.message);
  console.log(`onboarding shared for ${projectId}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
