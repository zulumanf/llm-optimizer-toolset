/**
 * Campaigns (spec 029): a grouping layer over existing execution objects —
 * objective + baseline + targets, with prompts/findings/tasks/interventions/
 * content attached as members. Adds no execution mechanics. Progress is
 * computed on read against the activation baseline and refuses to compare
 * across scoring versions (docs/06); causation language stays specs/007's.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { getSubjectCompany } from "@/db/companies";
import {
  assertCanWrite,
  assertProjectAccess,
  type CurrentUser,
} from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { firstZodMessage } from "@/lib/service-helpers";

export const MEMBER_KINDS = [
  "prompt",
  "gap_finding",
  "task",
  "intervention",
  "content_asset",
] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

const TARGETABLE_METRICS = [
  "mention_rate",
  "recommendation_rate",
  "first_position_rate",
  "top_three_rate",
  "share_of_voice",
  "citation_score",
  "authority_score",
] as const;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

const createSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().trim().min(1).max(120),
  objective: z.string().trim().min(1).max(1000),
  hypothesis: z.string().trim().max(2000).optional(),
  startsOn: dateSchema.nullish(),
  endsOn: dateSchema.nullish(),
  targetMetrics: z
    .array(
      z.object({
        metric: z.enum(TARGETABLE_METRICS),
        target: z.number().min(0).max(100),
      })
    )
    .max(10)
    .default([]),
});

interface BaselineSnapshot {
  runId: string;
  scoringVersion: string;
  capturedAt: string;
  // Array form on purpose: the postgres.js camel transform rewrites keys
  // INSIDE jsonb on read, so a {metric_name: value} map would come back
  // with silently different keys. String values are never transformed.
  metrics: { metric: string; value: number }[];
}

function baselineValue(
  snapshot: BaselineSnapshot | null,
  metric: string
): number | null {
  const row = snapshot?.metrics.find((m) => m.metric === metric);
  return row ? row.value : null;
}

export async function createCampaign(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ campaignId: string }>> {
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", firstZodMessage(parsed.error)));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    await assertProjectAccess(user, input.projectId);
    const campaignId = await sql.begin(async (tx) => {
      const [row] = await tx`
        insert into campaigns
          (project_id, name, objective, hypothesis, starts_on, ends_on,
           target_metrics, created_by)
        values (${input.projectId}, ${input.name}, ${input.objective},
          ${input.hypothesis ?? null}, ${input.startsOn ?? null},
          ${input.endsOn ?? null}, ${sql.json(input.targetMetrics as never)},
          ${user.id})
        returning id
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "campaign.create",
        entity: "campaign",
        entityId: row?.id as string,
        detail: { name: input.name },
      });
      return row?.id as string;
    });
    return ok({ campaignId });
  } catch (err) {
    return fail(err);
  }
}

/** Latest scored run's subject metrics (provider='all'). Null when the
 * project has no scored run yet. */
async function latestSubjectMetrics(
  projectId: string
): Promise<BaselineSnapshot | null> {
  const subject = await getSubjectCompany(projectId);
  if (!subject) return null;
  const [run] = await sql`
    select r.id from runs r
    where r.project_id = ${projectId}
      and exists (select 1 from scores s
        where s.run_id = r.id and s.company_id = ${subject.id})
    order by r.started_at desc limit 1
  `;
  if (!run) return null;
  const rows = await sql`
    select metric, value, scoring_version from scores
    where run_id = ${run.id} and company_id = ${subject.id}
      and provider = 'all'
  `;
  if (rows.length === 0) return null;
  return {
    runId: run.id as string,
    scoringVersion: rows[0]?.scoringVersion as string,
    capturedAt: new Date().toISOString(),
    metrics: rows.map((row) => ({
      metric: row.metric as string,
      value: Number(row.value),
    })),
  };
}

const TRANSITIONS: Record<string, { from: string[]; to: string }> = {
  activate: { from: ["draft"], to: "active" },
  complete: { from: ["active"], to: "completed" },
  abandon: { from: ["draft", "active"], to: "abandoned" },
};

export async function transitionCampaign(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ campaignId: string }>> {
  const parsed = z
    .object({
      campaignId: z.string().uuid(),
      action: z.enum(["activate", "complete", "abandon"]),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid campaign transition."));
  }
  const { campaignId, action } = parsed.data;
  const rule = TRANSITIONS[action]!;
  try {
    assertCanWrite(user);
    const [campaign] = await sql`
      select project_id, status from campaigns where id = ${campaignId}
    `;
    if (!campaign) return fail(new ClassifiedError("not_found", "Campaign not found."));
    await assertProjectAccess(user, campaign.projectId as string);
    if (!rule.from.includes(campaign.status as string)) {
      return fail(
        new ClassifiedError(
          "conflict",
          `Cannot ${action} a campaign in status "${campaign.status}".`
        )
      );
    }

    let baseline: BaselineSnapshot | null = null;
    if (action === "activate") {
      baseline = await latestSubjectMetrics(campaign.projectId as string);
      if (!baseline) {
        // A campaign without a baseline cannot report change honestly.
        return fail(
          new ClassifiedError(
            "conflict",
            "No scored run to baseline against — run and score a benchmark first."
          )
        );
      }
    }

    await sql.begin(async (tx) => {
      await tx`
        update campaigns set status = ${rule.to},
          baseline = ${action === "activate" ? sql.json(baseline as never) : sql`baseline`},
          updated_at = now()
        where id = ${campaignId} and status = ${campaign.status}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: `campaign.${action}`,
        entity: "campaign",
        entityId: campaignId,
        detail:
          action === "activate" ? { baselineRunId: baseline?.runId } : {},
      });
    });
    return ok({ campaignId });
  } catch (err) {
    return fail(err);
  }
}

/** Which table + project column proves a member belongs to the campaign's
 * client. A cross-table FK cannot express this; the service must. */
async function memberProjectId(
  kind: MemberKind,
  refId: string
): Promise<string | null> {
  const rows =
    kind === "prompt"
      ? await sql`select ps.project_id from prompts p
          join prompt_sets ps on ps.id = p.prompt_set_id where p.id = ${refId}`
      : kind === "gap_finding"
        ? await sql`select project_id from gap_findings where id = ${refId}`
        : kind === "task"
          ? await sql`select project_id from tasks where id = ${refId}`
          : kind === "intervention"
            ? await sql`select project_id from interventions where id = ${refId}`
            : await sql`select project_id from content_assets where id = ${refId}`;
  return (rows[0]?.projectId as string | undefined) ?? null;
}

export async function addCampaignMember(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ campaignId: string }>> {
  const parsed = z
    .object({
      campaignId: z.string().uuid(),
      kind: z.enum(MEMBER_KINDS),
      refId: z.string().uuid(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid member."));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [campaign] = await sql`
      select project_id, status from campaigns where id = ${input.campaignId}
    `;
    if (!campaign) return fail(new ClassifiedError("not_found", "Campaign not found."));
    await assertProjectAccess(user, campaign.projectId as string);
    if (campaign.status === "completed" || campaign.status === "abandoned") {
      return fail(
        new ClassifiedError("conflict", "Campaign is closed; members are frozen.")
      );
    }
    const memberProject = await memberProjectId(input.kind, input.refId);
    if (!memberProject) {
      return fail(new ClassifiedError("not_found", "Member object not found."));
    }
    if (memberProject !== (campaign.projectId as string)) {
      // Cross-client attachment is the exact blur campaigns must not allow.
      return fail(
        new ClassifiedError("conflict", "That object belongs to a different client.")
      );
    }
    await sql.begin(async (tx) => {
      await tx`
        insert into campaign_members (campaign_id, kind, ref_id, added_by)
        values (${input.campaignId}, ${input.kind}, ${input.refId}, ${user.id})
        on conflict do nothing
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "campaign.member_add",
        entity: "campaign",
        entityId: input.campaignId,
        detail: { kind: input.kind, refId: input.refId },
      });
    });
    return ok({ campaignId: input.campaignId });
  } catch (err) {
    return fail(err);
  }
}

export async function removeCampaignMember(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ campaignId: string }>> {
  const parsed = z
    .object({
      campaignId: z.string().uuid(),
      kind: z.enum(MEMBER_KINDS),
      refId: z.string().uuid(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid member."));
  }
  const input = parsed.data;
  try {
    assertCanWrite(user);
    const [campaign] = await sql`
      select project_id from campaigns where id = ${input.campaignId}
    `;
    if (!campaign) return fail(new ClassifiedError("not_found", "Campaign not found."));
    await assertProjectAccess(user, campaign.projectId as string);
    await sql.begin(async (tx) => {
      await tx`
        delete from campaign_members
        where campaign_id = ${input.campaignId} and kind = ${input.kind}
          and ref_id = ${input.refId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "campaign.member_remove",
        entity: "campaign",
        entityId: input.campaignId,
        detail: { kind: input.kind, refId: input.refId },
      });
    });
    return ok({ campaignId: input.campaignId });
  } catch (err) {
    return fail(err);
  }
}

export interface CampaignRow {
  id: string;
  name: string;
  objective: string;
  status: string;
  ownerId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  memberCount: number;
  createdAt: Date;
}

export async function listCampaigns(projectId: string): Promise<CampaignRow[]> {
  return sql<CampaignRow[]>`
    select c.id, c.name, c.objective, c.status, c.owner_id,
      c.starts_on::text, c.ends_on::text, c.created_at,
      (select count(*)::int from campaign_members m
        where m.campaign_id = c.id) as member_count
    from campaigns c
    where c.project_id = ${projectId}
    order by c.created_at desc
  `;
}

export interface CampaignProgressRow {
  metric: string;
  target: number;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  comparable: boolean;
}

export interface CampaignDetail {
  id: string;
  projectId: string;
  name: string;
  objective: string;
  hypothesis: string | null;
  status: string;
  startsOn: string | null;
  endsOn: string | null;
  baseline: BaselineSnapshot | null;
  progress: CampaignProgressRow[];
  members: { kind: MemberKind; refId: string; title: string }[];
}

async function memberTitle(kind: MemberKind, refId: string): Promise<string | null> {
  const rows =
    kind === "prompt"
      ? await sql`select text as title from prompts where id = ${refId}`
      : kind === "gap_finding"
        ? await sql`select gap_type || ' (' || severity || ')' as title
            from gap_findings where id = ${refId}`
        : kind === "task"
          ? await sql`select title from tasks where id = ${refId}`
          : kind === "intervention"
            ? await sql`select title from interventions where id = ${refId}`
            : await sql`select title from content_assets where id = ${refId}`;
  return (rows[0]?.title as string | undefined) ?? null;
}

export async function campaignDetail(
  campaignId: string
): Promise<CampaignDetail | null> {
  const [campaign] = await sql`
    select id, project_id, name, objective, hypothesis, status,
      starts_on::text, ends_on::text, baseline, target_metrics
    from campaigns where id = ${campaignId}
  `;
  if (!campaign) return null;

  const baseline = (campaign.baseline as BaselineSnapshot | null) ?? null;
  const targets = (campaign.targetMetrics ?? []) as {
    metric: string;
    target: number;
  }[];

  const current = await latestSubjectMetrics(campaign.projectId as string);
  const progress: CampaignProgressRow[] = targets.map((t) => {
    const baseValue = baselineValue(baseline, t.metric);
    const currentValue = baselineValue(current, t.metric);
    // Cross-version deltas are forbidden (docs/06): render not-comparable
    // rather than a number that silently mixes formula generations.
    const comparable =
      baseline !== null &&
      current !== null &&
      baseline.scoringVersion === current.scoringVersion;
    return {
      metric: t.metric,
      target: t.target,
      baseline: baseValue,
      current: comparable ? currentValue : null,
      delta:
        comparable && baseValue !== null && currentValue !== null
          ? currentValue - baseValue
          : null,
      comparable,
    };
  });

  const memberRows = await sql`
    select kind, ref_id from campaign_members
    where campaign_id = ${campaignId} order by added_at asc
  `;
  const members: CampaignDetail["members"] = [];
  for (const row of memberRows) {
    const kind = row.kind as MemberKind;
    const title = await memberTitle(kind, row.refId as string);
    members.push({
      kind,
      refId: row.refId as string,
      title: title ?? "(deleted)",
    });
  }

  return {
    id: campaign.id as string,
    projectId: campaign.projectId as string,
    name: campaign.name as string,
    objective: campaign.objective as string,
    hypothesis: (campaign.hypothesis as string | null) ?? null,
    status: campaign.status as string,
    startsOn: (campaign.startsOn as string | null) ?? null,
    endsOn: (campaign.endsOn as string | null) ?? null,
    baseline,
    progress,
    members,
  };
}
