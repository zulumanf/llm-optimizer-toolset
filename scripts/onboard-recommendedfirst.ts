/**
 * Onboard RecommendedFirst as the internal dogfood project: the same
 * measurement pipeline we sell, pointed at ourselves.
 *
 * Creates a kind='internal' project (excluded from every client/portfolio
 * surface — migration 084), the subject company, and the frozen v1 prompt
 * universe from lib/dogfood/prompts.ts. Competitors are deliberately NOT
 * seeded: the runs reveal who AI assistants actually recommend, and entity
 * discovery ranks them from observed mentions.
 *
 * Idempotent: refuses to run if an active internal RecommendedFirst project
 * already exists (the frozen baseline set must never be recreated).
 *
 * Run with: npx tsx scripts/onboard-recommendedfirst.ts
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { createProject } from "@/lib/projects/service";
import { upsertCompany } from "@/lib/companies/service";
import { setSubjectCompany } from "@/lib/claims/service";
import { createPromptSet, freezePromptSet } from "@/lib/prompts/set-service";
import { addPrompt } from "@/lib/prompts/prompt-service";
import {
  DOGFOOD_BRAND,
  DOGFOOD_DOMAIN,
  DOGFOOD_ALIASES,
  DOGFOOD_PROMPTS,
  dogfoodTierCounts,
} from "@/lib/dogfood/prompts";

async function main(): Promise<void> {
  const [row] = await sql`
    select id, email, name, role from users where email = 'zulumanf@gmail.com'
  `;
  if (!row) throw new Error("Operator user not found — provision it first.");
  const user: CurrentUser = {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as CurrentUser["role"],
  };

  const [existing] = await sql`
    select id from projects where kind = 'internal' and status = 'active'
      and lower(name) = lower(${DOGFOOD_BRAND})
  `;
  if (existing) {
    console.log(`Already onboarded — project ${existing.id}. Nothing to do.`);
    await sql.end();
    return;
  }

  const project = await createProject(user, {
    name: DOGFOOD_BRAND,
    description:
      "Internal dogfood — GEO/AEO platform for real estate. We run the same " +
      "AI-visibility measurement on ourselves that we run for clients.",
  });
  if (!project.ok) throw new Error(`project: ${project.error.message}`);
  const projectId = project.data.id;
  // createProject has no kind input by design; internal is a deliberate,
  // script-only promotion (mirrors lib/prospects/service.ts for 'prospect').
  await sql`update projects set kind = 'internal' where id = ${projectId}`;

  const company = await upsertCompany(user, {
    name: DOGFOOD_BRAND,
    aliases: DOGFOOD_ALIASES,
    domain: DOGFOOD_DOMAIN,
  });
  if (!company.ok) throw new Error(`company: ${company.error.message}`);
  const subject = await setSubjectCompany(user, {
    projectId,
    companyId: company.data.id,
  });
  if (!subject.ok) throw new Error(`subject: ${subject.error.message}`);

  const set = await createPromptSet(user, {
    projectId,
    name: "GEO/AEO visibility universe",
    description:
      "High-intent GEO software + real-estate prompts, tiered 1-3, plus " +
      "branded recognition controls (tier 4, echo-excluded from rates).",
  });
  if (!set.ok) throw new Error(`prompt set: ${set.error.message}`);

  let created = 0;
  for (const prompt of DOGFOOD_PROMPTS) {
    const added = await addPrompt(user, {
      setId: set.data.id,
      text: prompt.text,
      category: prompt.category,
      tier: prompt.tier,
      source: "manual",
    });
    if (!added.ok) throw new Error(`prompt "${prompt.text}": ${added.error.message}`);
    created += 1;
  }

  const frozen = await freezePromptSet(user, { id: set.data.id });
  if (!frozen.ok) throw new Error(`freeze: ${frozen.error.message}`);

  const tiers = dogfoodTierCounts();
  console.log(`${DOGFOOD_BRAND} onboarded as internal dogfood project`);
  console.log("  project:    ", projectId);
  console.log("  company:    ", company.data.id);
  console.log("  prompt set: ", set.data.id, `frozen v${frozen.data.version}`);
  console.log(`  prompts:     ${created} (T1 ${tiers[1]} · T2 ${tiers[2]} · T3 ${tiers[3]} · branded ${tiers[4]})`);
  console.log("  next:        start the baseline run from /projects/" + projectId + "/runs");
  await sql.end();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
  await sql.end();
});
