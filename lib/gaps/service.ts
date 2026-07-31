/**
 * Gap analysis service (spec 009): assembles detector inputs from a scored
 * run's structured data, persists typed findings, and turns a finding into
 * an evidence-backed suggested task (human approves — PRINCIPLES #8).
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { getSubjectCompany } from "@/db/companies";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { suggestTask } from "@/lib/tasks/service";
import {
  detectGaps,
  DETECTOR_VERSION,
  type PromptOutcome,
  type CompanyOutcome,
  type DomainCitation,
} from "@/lib/gaps/detect";
import { extractUrls, urlDomain } from "@/lib/parsing/prepass";
import { extractCitations } from "@/lib/ai/citations";
import { log } from "@/lib/logger";

export async function analyzeRun(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ runId: string; findings: number }>> {
  const parsed = z.object({ runId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid run id."));
  }
  const { runId } = parsed.data;
  try {
    assertCanWrite(user);
    const [run] = await sql`
      select id, project_id, status from runs where id = ${runId}
    `;
    if (!run) return fail(new ClassifiedError("not_found", "Run not found."));
    const [scored] = await sql`select 1 from scores where run_id = ${runId} limit 1`;
    if (!scored) {
      return fail(
        new ClassifiedError("conflict", "Run has no scores yet — analysis needs a scored run.")
      );
    }
    const projectId = run.projectId as string;
    const subject = await getSubjectCompany(projectId);
    if (!subject) {
      return fail(new ClassifiedError("conflict", "Project has no subject company."));
    }

    // Per-prompt outcomes for the subject (current-revision mentions)
    const promptRows = await sql`
      select r.prompt_id,
        coalesce(
          -- frozen_prompts keys are camelCase (lib/prompts/types.ts)
          (select p.category from prompt_set_versions v,
             jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, category text)
           where v.id = runs.prompt_set_version_id and p."promptId" = r.prompt_id),
          'recommendation') as category,
        count(*) filter (where r.error is null)::int as responses,
        count(*) filter (where m.mentioned)::int as subject_mentioned,
        count(*) filter (where m.recommended)::int as subject_recommended,
        count(*) filter (where m.cited_urls != '{}')::int as subject_cited
      from responses r
      join runs on runs.id = r.run_id
      left join mentions m on m.response_id = r.id
        and m.company_id = ${subject.id}
        and not exists (select 1 from mentions n
          where n.response_id = m.response_id and n.company_id = m.company_id
            and n.revision > m.revision)
      where r.run_id = ${runId}
      group by r.prompt_id, runs.prompt_set_version_id
    `;
    const prompts: PromptOutcome[] = promptRows.map((r) => ({
      promptId: r.promptId as string,
      category: r.category as string,
      responses: r.responses as number,
      subjectMentioned: r.subjectMentioned as number,
      subjectRecommended: r.subjectRecommended as number,
      subjectCited: r.subjectCited as number,
    }));

    const companyRows = await sql`
      select s.company_id, c.name, s.metric, s.value
      from scores s join companies c on c.id = s.company_id
      where s.run_id = ${runId} and s.provider = 'all'
        and s.metric in ('mention_rate', 'recommendation_rate')
    `;
    const byCompany = new Map<string, CompanyOutcome>();
    for (const row of companyRows) {
      const id = row.companyId as string;
      if (!byCompany.has(id)) {
        byCompany.set(id, {
          companyId: id,
          name: row.name as string,
          isSubject: id === subject.id,
          mentionRate: 0,
          recommendationRate: 0,
          organicMentionRate: null,
          organicRecommendationRate: null,
          organicResponses: 0,
        });
      }
      const entry = byCompany.get(id)!;
      if (row.metric === "mention_rate") entry.mentionRate = Number(row.value);
      else entry.recommendationRate = Number(row.value);
    }

    /**
     * Organic rates: per company, over responses to prompts that did NOT name
     * that company.
     *
     * Prompt *category* cannot decide this. "Who are the best SERHANT agents
     * in Jersey City?" is categorised `recommendation`, yet a SERHANT mention
     * in its answer measures nothing but our own question coming back. So the
     * exclusion is per company and based on the prompt text — a
     * SERHANT-anchored prompt still counts as organic evidence for Compass.
     *
     * Matching uses name plus aliases, the same vocabulary the classifier uses
     * to detect a mention in the first place. Tokens of 3 characters or fewer
     * are skipped: a two-letter alias matches half the English language.
     */
    const organicRows = await sql`
      with named as (
        select c.id as company_id, r.id as response_id,
          exists (
            select 1 from unnest(array[c.name] || coalesce(c.aliases, '{}')) as token
            where length(trim(token)) > 3
              and r.prompt_text ilike '%' || trim(token) || '%'
          ) as prompt_named_company
        from responses r
        cross join companies c
        where r.run_id = ${runId} and r.error is null
          and c.id = any(${[...byCompany.keys()]}::uuid[])
      )
      select n.company_id,
        count(*) filter (where not n.prompt_named_company)::int as organic_responses,
        count(*) filter (where not n.prompt_named_company and m.mentioned)::int as organic_mentions,
        count(*) filter (where not n.prompt_named_company and m.recommended)::int as organic_recommendations
      from named n
      left join mentions m on m.response_id = n.response_id
        and m.company_id = n.company_id
        and not exists (
          select 1 from mentions later
          where later.response_id = m.response_id
            and later.company_id = m.company_id
            and later.revision > m.revision
        )
      group by n.company_id
    `;
    for (const row of organicRows) {
      const entry = byCompany.get(row.companyId as string);
      if (!entry) continue;
      const responses = Number(row.organicResponses ?? 0);
      entry.organicResponses = responses;
      // Null, not zero: a company that every prompt named has no organic
      // sample, and 0% there would read as invisibility rather than as "this
      // run cannot answer that question".
      entry.organicMentionRate =
        responses === 0 ? null : Number(row.organicMentions ?? 0) / responses;
      entry.organicRecommendationRate =
        responses === 0 ? null : Number(row.organicRecommendations ?? 0) / responses;
    }

    // Domain citations: in-text URLs plus the search citations each provider
    // actually retrieved (payload re-scan — works retroactively, immutable)
    const textRows = await sql`
      select provider, response_text, raw_payload from responses
      where run_id = ${runId} and error is null
    `;
    const domainCounts = new Map<string, number>();
    const bump = (domain: string | null) => {
      if (domain) domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
    };
    for (const row of textRows) {
      for (const url of extractUrls((row.responseText as string) ?? "")) {
        bump(urlDomain(url));
      }
      for (const citation of extractCitations(row.provider as string, row.rawPayload)) {
        bump(citation.domain);
      }
    }
    const domains: DomainCitation[] = [...domainCounts.entries()].map(
      ([domain, citations]) => ({
        domain,
        citations,
        ownedBySubject: Boolean(subject.domain && domain.endsWith(subject.domain)),
      })
    );

    const findings = detectGaps({
      subjectName: subject.name,
      subjectDomain: subject.domain,
      prompts,
      companies: [...byCompany.values()],
      domains,
    });

    await sql.begin(async (tx) => {
      for (const finding of findings) {
        await tx`
          insert into gap_findings
            (project_id, run_id, prompt_category, gap_type, finding, detail,
             severity, opportunity_score, detector_version)
          values
            (${projectId}, ${runId}, ${finding.promptCategory},
             ${finding.gapType}, ${finding.finding},
             ${tx.json(finding.detail as never)},
             ${Number(finding.severity.toFixed(3))},
             ${Number(finding.opportunityScore.toFixed(1))},
             ${DETECTOR_VERSION})
          on conflict (run_id, gap_type, coalesce(prompt_category, '')) do nothing
        `;
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "gaps.analyze",
        entity: "run",
        entityId: runId,
        detail: { findings: findings.length, detectorVersion: DETECTOR_VERSION },
      });
    });
    log("info", "gaps.analyzed", { runId, findings: findings.length });
    return ok({ runId, findings: findings.length });
  } catch (err) {
    return fail(err);
  }
}

/** Turn a finding into an evidence-backed suggested task (yellow level). */
export async function createTaskFromFinding(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = z.object({ findingId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid finding id."));
  }
  try {
    assertCanWrite(user);
    const [finding] = await sql`
      select f.*, s.id as score_id
      from gap_findings f
      left join lateral (
        select id from scores
        where run_id = f.run_id order by computed_at asc limit 1
      ) s on true
      where f.id = ${parsed.data.findingId}
    `;
    if (!finding) return fail(new ClassifiedError("not_found", "Finding not found."));
    if (finding.status !== "open") {
      return fail(new ClassifiedError("conflict", `Finding is ${finding.status}.`));
    }

    const result = await suggestTask(user, {
      projectId: finding.projectId as string,
      title: `[${finding.gapType}] ${String(finding.finding).slice(0, 100)}`,
      description: `${finding.finding}\n\nOpportunity score ${finding.opportunityScore} (detector ${finding.detectorVersion}).`,
      priority: Number(finding.opportunityScore) >= 70 ? "p1" : "p2",
      evidence: [
        {
          kind: "score",
          refId: finding.scoreId as string,
          note: `Gap finding from run ${String(finding.runId).slice(0, 8)}: ${finding.gapType} (severity ${finding.severity}).`,
        },
      ],
    });
    if (!result.ok) return result;

    await sql`
      update gap_findings set status = 'task_created' where id = ${finding.id}
    `;
    return result;
  } catch (err) {
    return fail(err);
  }
}

/** Undo a dismissal (UX): dismissing is one keystroke away from a mistake,
 * so it must be reversible. Only reverses dismissal — a finding that became
 * a task keeps its task link. */
export async function reopenFinding(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ findingId: string }>> {
  const parsed = z.object({ findingId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid finding id."));
  }
  try {
    assertCanWrite(user);
    const [row] = await sql`
      update gap_findings set status = 'open'
      where id = ${parsed.data.findingId} and status = 'dismissed'
      returning id
    `;
    if (!row) {
      return fail(new ClassifiedError("conflict", "Only dismissed findings can be reopened."));
    }
    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "gaps.reopen",
        entity: "gap_finding",
        entityId: parsed.data.findingId,
      })
    );
    return ok({ findingId: parsed.data.findingId });
  } catch (err) {
    return fail(err);
  }
}

export async function dismissFinding(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ findingId: string }>> {
  const parsed = z.object({ findingId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid finding id."));
  }
  try {
    assertCanWrite(user);
    const [row] = await sql`
      update gap_findings set status = 'dismissed'
      where id = ${parsed.data.findingId} and status = 'open'
      returning id
    `;
    if (!row) return fail(new ClassifiedError("conflict", "Finding is not open."));
    await sql.begin((tx) =>
      writeAudit(tx, {
        userId: user.id,
        action: "gaps.dismiss",
        entity: "gap_finding",
        entityId: parsed.data.findingId,
      })
    );
    return ok({ findingId: parsed.data.findingId });
  } catch (err) {
    return fail(err);
  }
}
