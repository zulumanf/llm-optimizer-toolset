/**
 * Market benchmark bootstrap (spec 096 follow-up). The missing rung between
 * an installed market pack and a benchmark run: for a launch, create (or
 * find) the market benchmark project, generate its prompt set from the
 * installed pack's templates, freeze it, and hand back every id the run
 * needs — so neither the operator nor the assistant plumbs UUIDs by hand.
 *
 * Internal artifacts only (project, prompts, frozen version) — spending
 * money on a run stays behind its own confirmation, and the operator is
 * pointed at the prompt set for review before confirming (docs/07: a human
 * reviews prompts before anything runs; edits create a new frozen version).
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { createProject } from "@/lib/projects/service";
import { upsertCompany } from "@/lib/companies/service";
import { setSubjectCompany } from "@/lib/claims/service";
import { addPrompt } from "@/lib/prompts/prompt-service";
import { createPromptSet, freezePromptSet } from "@/lib/prompts/set-service";
import { expandMarketPack } from "@/lib/markets/generate";
import type { MarketPackDefinition } from "@/lib/markets/types";

export interface BootstrapResult {
  cityName: string;
  projectId: string;
  promptSetId: string;
  promptSetVersionId: string;
  promptCount: number;
  /** Provider config copied from the most recent completed benchmark run —
   * real, previously human-approved configuration, never an invention.
   * Null when no prior run exists to copy from. */
  suggestedProviders: unknown[] | null;
  alreadyBootstrapped: boolean;
}

const inputSchema = z.object({
  launchId: z.string().uuid(),
  /** Prompt-count cap for the expansion; the pack's own cap still applies. */
  cap: z.number().int().min(4).max(200).default(64),
});

export async function bootstrapMarketBenchmark(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<BootstrapResult>> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "A launch id is required."));
  }
  try {
    assertCanWrite(user);
    const [launch] = await sql`
      select l.id, m.name as market_name
      from market_launches l join markets m on m.id = l.market_id
      where l.id = ${parsed.data.launchId}
    `;
    if (!launch) throw new ClassifiedError("not_found", "Launch not found.");
    const marketName = launch.marketName as string;

    const projectName = `Market benchmark: ${marketName}`;

    // Idempotent: a second bootstrap returns the existing plumbing instead
    // of minting a duplicate project.
    const [existing] = await sql`
      select p.id as project_id, s.id as set_id, v.id as version_id,
        (select count(*)::int from prompts where prompt_set_id = s.id
          and archived_at is null) as prompt_count
      from projects p
      join prompt_sets s on s.project_id = p.id
      join prompt_set_versions v on v.prompt_set_id = s.id
      where p.name = ${projectName} and p.archived_at is null
      order by v.version desc limit 1
    `;
    if (existing) {
      return ok({
        cityName: marketName,
        projectId: existing.projectId as string,
        promptSetId: existing.setId as string,
        promptSetVersionId: existing.versionId as string,
        promptCount: Number(existing.promptCount ?? 0),
        suggestedProviders: await latestRunProviders(),
        alreadyBootstrapped: true,
      });
    }

    // The pack: installed drafts carry the full Perplexity-composed
    // definition in their payload (static built-in packs are the JC-era
    // path and register their prompts through the prompt-library UI).
    const [draft] = await sql`
      select payload from market_pack_drafts
      where status = 'installed'
        and payload->>'cityName' ilike ${marketName.split("—")[0]!.trim().split(",")[0]!.trim() + "%"}
      order by created_at desc limit 1
    `;
    if (!draft) {
      throw new ClassifiedError(
        "not_found",
        `No installed market pack found for "${marketName}" — run research_market and install_market_pack first.`
      );
    }
    const pack = draft.payload as unknown as MarketPackDefinition;

    // Parsing needs a subject company to anchor (specs 004+): for a
    // market-wide discovery run the anchor is the pack's first prominent
    // local brokerage — a real, Perplexity-cited entity, never an invention.
    // The same precedent createBenchmarkProject sets per-prospect.
    const anchorName = pack.brokerages[0];
    if (!anchorName) {
      throw new ClassifiedError(
        "validation",
        "The installed pack lists no local brokerages, so the benchmark has no honest subject anchor — add one to the pack (or set a subject in the project UI) before benchmarking."
      );
    }

    const project = await createProject(user, {
      name: projectName,
      description: `Market-level benchmark for ${marketName} prospecting (bootstrapped from the installed market pack). Subject anchor: ${anchorName}, a prominent local brokerage from the pack — not a client.`,
    });
    if (!project.ok) return project;
    await sql`update projects set kind = 'prospect' where id = ${project.data.id}`;
    // The anchor may already exist — discovery seeds prospects' companies
    // before the benchmark is bootstrapped, and a brokerage named in the
    // pack is often one of them. Reuse by name; only mint when absent.
    const [existingAnchor] = await sql`
      select id from companies where lower(name) = lower(${anchorName}) and archived_at is null
      limit 1
    `;
    let anchorId: string;
    if (existingAnchor) anchorId = existingAnchor.id as string;
    else {
      const anchor = await upsertCompany(user, { name: anchorName, aliases: [] });
      if (!anchor.ok) return anchor;
      anchorId = anchor.data.id;
    }
    const subject = await setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: anchorId,
    });
    if (!subject.ok) return subject;

    const set = await createPromptSet(user, {
      projectId: project.data.id,
      name: `${marketName} market prompts`,
    });
    if (!set.ok) return set;

    const expansion = expandMarketPack(pack, { cap: parsed.data.cap });
    if (expansion.prompts.length === 0) {
      throw new ClassifiedError(
        "validation",
        "The installed pack expanded to zero prompts — review its templates before benchmarking."
      );
    }
    let created = 0;
    for (const prompt of expansion.prompts) {
      const added = await addPrompt(user, {
        setId: set.data.id,
        text: prompt.text,
        category: prompt.category,
        tier: prompt.tier,
        source: "expansion",
        audience: prompt.audience,
        priceTier: prompt.priceTier ?? undefined,
        templateRef: prompt.templateRef,
        neighborhood: prompt.neighborhood ?? undefined,
        propertyType: prompt.propertyType ?? undefined,
      });
      if (!added.ok) {
        return fail(
          new ClassifiedError("internal", `Prompt insert failed: ${added.error.message}`)
        );
      }
      created += 1;
    }

    const frozen = await freezePromptSet(user, { id: set.data.id });
    if (!frozen.ok) return frozen;
    const [version] = await sql`
      select id from prompt_set_versions
      where prompt_set_id = ${set.data.id}
      order by version desc limit 1
    `;

    return ok({
      cityName: marketName,
      projectId: project.data.id,
      promptSetId: set.data.id,
      promptSetVersionId: version?.id as string,
      promptCount: created,
      suggestedProviders: await latestRunProviders(),
      alreadyBootstrapped: false,
    });
  } catch (err) {
    return fail(err);
  }
}

/** The provider config of the newest completed run — copied, not invented. */
async function latestRunProviders(): Promise<unknown[] | null> {
  const [run] = await sql`
    select providers from runs
    where status = 'completed' and providers != '[]'::jsonb
    order by completed_at desc nulls last limit 1
  `;
  const providers = run?.providers as unknown[] | undefined;
  return providers && providers.length > 0 ? providers : null;
}
