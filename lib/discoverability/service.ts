/**
 * Technical discoverability service (spec 088): request a scan, read the
 * latest one, and promote findings into the EXISTING task queue — same
 * evidence gate, same priority vocabulary, no parallel task system.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { enqueueJob } from "@/db/jobs";
import { getSubjectCompany } from "@/db/companies";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { suggestTask } from "@/lib/tasks/service";
import { playbookFor } from "@/lib/sources/playbooks";
import type { PriorityBand } from "@/lib/gaps/detect";
import type { Severity } from "@/lib/discoverability/findings";

export interface SiteFindingRow {
  id: string;
  projectId: string;
  scanId: string;
  pageId: string | null;
  pageUrl: string | null;
  checkType: string;
  severity: Severity;
  observation: string;
  inference: string | null;
  recommendation: string;
  detail: Record<string, unknown>;
  priorityScore: number;
  priorityBand: PriorityBand;
  scannerVersion: string;
  status: "open" | "task_created" | "dismissed";
  taskId: string | null;
  createdAt: Date;
}

export interface SiteScanSummary {
  id: string;
  domain: string;
  status: "running" | "completed" | "failed";
  scannerVersion: string;
  robots: Record<string, unknown> | null;
  sitemaps: Record<string, unknown> | null;
  pagesFetched: number;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

/** Queue a scan. Refused (not queued-and-failed-later) when the project has
 * no subject domain — the operator can fix the actual blocker. */
export async function requestTechnicalScan(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ queued: boolean }>> {
  const parsed = z.object({ projectId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid project id."));
  }
  const { projectId } = parsed.data;
  try {
    assertCanWrite(user);
    const subject = await getSubjectCompany(projectId);
    if (!subject?.domain) {
      return fail(
        new ClassifiedError(
          "conflict",
          "The project's subject company has no domain — set one before scanning."
        )
      );
    }
    const [running] = await sql`
      select id from site_scans
      where project_id = ${projectId} and status = 'running'
      limit 1
    `;
    if (running) {
      return fail(new ClassifiedError("conflict", "A scan is already running."));
    }
    await sql.begin(async (tx) => {
      await enqueueJob(tx, "technical_scan", { projectId, startedBy: user.id });
      await writeAudit(tx, {
        userId: user.id,
        action: "technical_scan.request",
        entity: "project",
        entityId: projectId,
        detail: { domain: subject.domain },
      });
    });
    return ok({ queued: true });
  } catch (err) {
    return fail(err);
  }
}

export async function latestScan(projectId: string): Promise<SiteScanSummary | null> {
  const rows = await sql<SiteScanSummary[]>`
    select id, domain, status, scanner_version, robots, sitemaps,
      pages_fetched, error, created_at, completed_at
    from site_scans
    where project_id = ${projectId}
    order by created_at desc
    limit 1
  `;
  return rows[0] ?? null;
}

export async function listScanFindings(scanId: string): Promise<SiteFindingRow[]> {
  return sql<SiteFindingRow[]>`
    select f.id, f.project_id, f.scan_id, f.page_id, p.url as page_url,
      f.check_type, f.severity, f.observation, f.inference, f.recommendation,
      f.detail, f.priority_score, f.priority_band, f.scanner_version,
      f.status, f.task_id, f.created_at
    from site_findings f
    left join site_pages p on p.id = f.page_id
    where f.scan_id = ${scanId}
    order by f.priority_score desc, f.created_at asc
  `;
}

/** Promote a finding into the shared task queue. The task's evidence is the
 * scanned page row (or the scan itself for scan-level findings) — real,
 * reproducible refs through the same gate every other task clears. */
export async function createTaskFromSiteFinding(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ taskId: string }>> {
  const parsed = z.object({ findingId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid finding id."));
  }
  try {
    assertCanWrite(user);
    const [finding] = await sql<SiteFindingRow[]>`
      select f.id, f.project_id, f.scan_id, f.page_id, p.url as page_url,
        f.check_type, f.severity, f.observation, f.inference,
        f.recommendation, f.detail, f.priority_score, f.priority_band,
        f.scanner_version, f.status, f.task_id, f.created_at
      from site_findings f
      left join site_pages p on p.id = f.page_id
      where f.id = ${parsed.data.findingId}
    `;
    if (!finding) return fail(new ClassifiedError("not_found", "Finding not found."));
    if (finding.status !== "open") {
      return fail(new ClassifiedError("conflict", `Finding is ${finding.status}.`));
    }

    // Owned-site work: the client_site playbook carries the legitimate moves.
    const playbook = playbookFor("client_site");
    const playbookNote =
      playbook && ["orphan_page", "missing_entity_schema", "stale_authority_page", "intent_coverage_gap"].includes(finding.checkType)
        ? `\n\nPlaybook: ${playbook.actions.join("; ")}.`
        : "";
    const description =
      `OBSERVATION: ${finding.observation}\n` +
      (finding.inference ? `INFERENCE: ${finding.inference}\n` : "") +
      `RECOMMENDATION: ${finding.recommendation}\n\n` +
      `Severity ${finding.severity}, priority ${finding.priorityBand} ` +
      `(${finding.scannerVersion}).${playbookNote}`;

    const result = await suggestTask(user, {
      projectId: finding.projectId,
      title: `[technical] ${finding.observation.slice(0, 100)}`,
      description: description.slice(0, 2000),
      priority:
        finding.priorityBand === "do_now"
          ? "p1"
          : finding.priorityBand === "do_next"
            ? "p2"
            : "p3",
      evidence: [
        finding.pageId
          ? {
              kind: "site_page",
              refId: finding.pageId,
              note: `Scanned page ${finding.pageUrl ?? ""} — the ${finding.checkType} facts live on this row.`,
            }
          : {
              kind: "site_scan",
              refId: finding.scanId,
              note: `Technical scan whose robots/sitemap facts support this ${finding.checkType} finding.`,
            },
      ],
    });
    if (!result.ok) return result;

    await sql`
      update site_findings
      set status = 'task_created', task_id = ${result.data.taskId}
      where id = ${finding.id}
    `;
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function dismissSiteFinding(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ findingId: string }>> {
  const parsed = z.object({ findingId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid finding id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update site_findings set status = 'dismissed'
        where id = ${parsed.data.findingId} and status = 'open'
        returning id
      `;
      if (!row) throw new ClassifiedError("conflict", "Not found or not open.");
      await writeAudit(tx, {
        userId: user.id,
        action: "site_finding.dismiss",
        entity: "site_finding",
        entityId: parsed.data.findingId,
      });
    });
    return ok({ findingId: parsed.data.findingId });
  } catch (err) {
    return fail(err);
  }
}

export async function reopenSiteFinding(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ findingId: string }>> {
  const parsed = z.object({ findingId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid finding id."));
  }
  try {
    assertCanWrite(user);
    await sql.begin(async (tx) => {
      const [row] = await tx`
        update site_findings set status = 'open'
        where id = ${parsed.data.findingId} and status = 'dismissed'
        returning id
      `;
      if (!row) {
        throw new ClassifiedError("conflict", "Not found or not dismissed.");
      }
      await writeAudit(tx, {
        userId: user.id,
        action: "site_finding.reopen",
        entity: "site_finding",
        entityId: parsed.data.findingId,
      });
    });
    return ok({ findingId: parsed.data.findingId });
  } catch (err) {
    return fail(err);
  }
}
