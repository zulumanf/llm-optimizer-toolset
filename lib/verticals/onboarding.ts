/**
 * Client onboarding (spec 012) — the agency's core operation, made
 * repeatable. One call turns an operator's answers into a fully configured
 * client: pinned vertical pack, subject company, approved identity claims,
 * tracked competitors, and a generated prompt set ready for human review.
 *
 * What it deliberately does NOT do: freeze the prompt set or start a run.
 * A human reviews and edits the generated prompts first — the benchmark is
 * the instrument, and instruments are not auto-created (docs/07).
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";
import { createProject } from "@/lib/projects/service";
import { upsertCompany } from "@/lib/companies/service";
import { addCompetitor } from "@/lib/competitors/service";
import { setSubjectCompany, proposeClaim, approveClaim } from "@/lib/claims/service";
import { createPromptSet } from "@/lib/prompts/set-service";
import { addPrompt } from "@/lib/prompts/prompt-service";
import { findPack } from "@/lib/verticals/packs";
import { expandPack, missingRequiredVariables } from "@/lib/verticals/expand";
import type { VerticalPackDefinition } from "@/lib/verticals/types";
import { log } from "@/lib/logger";

const onboardSchema = z.object({
  clientName: z.string().trim().min(1).max(120),
  packKey: z.string().min(1).max(60),
  company: z.object({
    name: z.string().trim().min(1).max(120),
    aliases: z.array(z.string().trim().min(1)).max(20).default([]),
    domain: z.string().trim().max(200).nullable().optional(),
  }),
  /** Multi-valued variables arrive as arrays; single-valued as one entry. */
  variables: z.record(z.string(), z.array(z.string())).default({}),
  /** Facts the operator can evidence today. Each becomes an approved claim. */
  facts: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(60),
        text: z.string().trim().min(1).max(500),
        evidenceUrl: z.string().url(),
      })
    )
    .max(20)
    .default([]),
  competitors: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        domain: z.string().trim().max(200).nullable().optional(),
        tier: z.enum(["primary", "secondary"]).default("secondary"),
      })
    )
    .max(15)
    .default([]),
});

export interface OnboardingResult {
  projectId: string;
  companyId: string;
  promptSetId: string;
  promptsCreated: number;
  claimsApproved: number;
  competitorsTracked: number;
  packVersion: number;
}

/** Pin the current pack definition, reusing the row if this version exists.
 * Projects reference the pinned snapshot, so editing packs later never
 * mutates a live client's configuration. */
async function pinPack(pack: VerticalPackDefinition): Promise<string> {
  const [existing] = await sql`
    select id from vertical_packs
    where key = ${pack.key} and version = ${pack.version}
  `;
  if (existing) return existing.id as string;
  const [row] = await sql`
    insert into vertical_packs (key, version, name, description, definition)
    values (${pack.key}, ${pack.version}, ${pack.name}, ${pack.description},
      ${sql.json(pack as never)})
    on conflict (key, version) do update set name = excluded.name
    returning id
  `;
  return row?.id as string;
}

export async function onboardClient(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<OnboardingResult>> {
  const parsed = onboardSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;

  const pack = findPack(input.packKey);
  if (!pack) {
    return fail(new ClassifiedError("validation", `Unknown vertical pack: ${input.packKey}`));
  }
  const missing = missingRequiredVariables(pack, input.variables);
  if (missing.length > 0) {
    return fail(
      new ClassifiedError("validation", `Missing required inputs: ${missing.join(", ")}`)
    );
  }

  try {
    const packId = await pinPack(pack);

    // 1. Client project
    const project = await createProject(user, {
      name: input.clientName,
      description: `${pack.name} · onboarded from pack ${pack.key} v${pack.version}`,
    });
    if (!project.ok) return project;
    const projectId = project.data.id;
    await sql`
      update projects set vertical_pack_id = ${packId} where id = ${projectId}
    `;

    // 2. Subject company + identity
    const company = await upsertCompany(user, {
      name: input.company.name,
      aliases: input.company.aliases,
      domain: input.company.domain ?? null,
    });
    if (!company.ok) return company;
    const subject = await setSubjectCompany(user, {
      projectId,
      companyId: company.data.id,
    });
    if (!subject.ok) return subject;

    // 3. Approved claims — proposed then approved by the same operator, which
    // is exactly the manual flow (spec 008) compressed into one action.
    let claimsApproved = 0;
    for (const fact of input.facts) {
      const proposed = await proposeClaim(user, {
        projectId,
        key: fact.key,
        canonicalText: fact.text,
        asOf: new Date().toISOString().slice(0, 10),
        evidence: [{ url: fact.evidenceUrl, note: `Recorded at onboarding by ${user.email}.` }],
      });
      if (!proposed.ok) continue; // a bad fact must not abort the onboarding
      const approved = await approveClaim(user, { claimId: proposed.data.id });
      if (approved.ok) claimsApproved += 1;
    }

    // 4. Competitors
    let competitorsTracked = 0;
    for (const competitor of input.competitors) {
      const competitorCompany = await upsertCompany(user, {
        name: competitor.name,
        aliases: [],
        domain: competitor.domain ?? null,
      });
      if (!competitorCompany.ok) continue;
      const tracked = await addCompetitor(user, {
        projectId,
        companyId: competitorCompany.data.id,
        tier: competitor.tier,
      });
      if (tracked.ok) competitorsTracked += 1;
    }

    // 5. Generated prompt set — left UNFROZEN for human review (docs/07)
    const set = await createPromptSet(user, {
      projectId,
      name: `${pack.name} benchmark`,
      description: `Generated from ${pack.key} v${pack.version}. Review and edit before freezing.`,
    });
    if (!set.ok) return set;

    const generated = expandPack({
      pack,
      variables: input.variables,
      brand: input.company.name,
      competitors: input.competitors.map((c) => c.name),
    });
    let promptsCreated = 0;
    for (const prompt of generated) {
      const added = await addPrompt(user, {
        setId: set.data.id,
        text: prompt.text,
        category: prompt.category,
        isHoldout: prompt.isHoldout,
      });
      if (added.ok) promptsCreated += 1;
    }

    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "client.onboard",
        entity: "project",
        entityId: projectId,
        detail: {
          packKey: pack.key,
          packVersion: pack.version,
          promptsCreated,
          claimsApproved,
          competitorsTracked,
        },
      })
    );
    log("info", "client.onboarded", {
      projectId,
      pack: pack.key,
      promptsCreated,
      competitorsTracked,
    });

    return ok({
      projectId,
      companyId: company.data.id,
      promptSetId: set.data.id,
      promptsCreated,
      claimsApproved,
      competitorsTracked,
      packVersion: pack.version,
    });
  } catch (err) {
    return fail(err);
  }
}

/** Compliance rules for a project's pinned pack — consumed by the content
 * gate (spec 010) so regulated verticals are checked, not hoped about. */
export async function complianceRulesFor(
  projectId: string
): Promise<VerticalPackDefinition["compliance"]> {
  const [row] = await sql`
    select p.definition from projects pr
    join vertical_packs p on p.id = pr.vertical_pack_id
    where pr.id = ${projectId}
  `;
  if (!row) return [];
  return (row.definition as VerticalPackDefinition).compliance ?? [];
}
