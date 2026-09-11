/**
 * Spec 025 acceptance criteria, against a real database.
 *
 * The two that carry the design are asserted directly:
 *   - the daily job **reconciles rather than regenerates** (pagesRebuilt must
 *     stay far below pagesConsidered), and
 *   - it is **idempotent per window** (a second call in the same window does
 *     no work at all).
 *
 * Everything else — the detectors, the auto-resolve, the legal hold — is a
 * property that only shows up against real rows and real constraints.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000901",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("knowledge maintenance (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let svc: typeof import("@/lib/knowledge/maintenance/service");
  let exceptions: typeof import("@/lib/knowledge/maintenance/exceptions");
  let detectors: typeof import("@/lib/knowledge/maintenance/detectors");
  let metrics: typeof import("@/lib/knowledge/maintenance/metrics");
  let projectSvc: typeof import("@/lib/projects/service");

  let projectId = "";

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    svc = await import("@/lib/knowledge/maintenance/service");
    exceptions = await import("@/lib/knowledge/maintenance/exceptions");
    detectors = await import("@/lib/knowledge/maintenance/detectors");
    metrics = await import("@/lib/knowledge/maintenance/metrics");
    projectSvc = await import("@/lib/projects/service");

    await seedTestActors(sql);
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql.unsafe(`
      truncate knowledge_exceptions, knowledge_maintenance_runs,
        retrieval_evaluations, source_artifacts, claims, evidence,
        wiki_pages, wiki_page_versions, wiki_sections, wiki_section_provenance,
        wiki_page_dependencies, knowledge_builds, knowledge_build_items,
        audit_log, projects
      restart identity cascade
    `);
    const created = await projectSvc.createProject(user, { name: "Maintenance Client" });
    if (!created.ok) throw new Error(created.error.message);
    projectId = created.data.id;
  });

  // ------------------------------------------------------------ idempotency

  it("runs a window once, however many callers fire the heartbeat", async () => {
    const now = new Date("2026-07-30T09:00:00Z");
    const first = await svc.runDailyMaintenance({ projectId, now, rebuild: false });
    expect(first.alreadyRan).toBe(false);

    const second = await svc.runDailyMaintenance({ projectId, now, rebuild: false });
    expect(second.alreadyRan).toBe(true);
    expect(second.id).toBe(first.id);

    const runs = await sql`select id from knowledge_maintenance_runs where kind = 'daily'`;
    expect(runs).toHaveLength(1);
  });

  it("survives concurrent dispatchers racing the same window", async () => {
    const now = new Date("2026-07-30T09:00:00Z");
    const results = await Promise.all([
      svc.runDailyMaintenance({ projectId, now, rebuild: false }),
      svc.runDailyMaintenance({ projectId, now, rebuild: false }),
      svc.runDailyMaintenance({ projectId, now, rebuild: false }),
    ]);
    // Exactly one did the work; the unique index arbitrated, not a lock.
    expect(results.filter((r) => !r.alreadyRan)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it("starts a new run in the next window", async () => {
    await svc.runDailyMaintenance({
      projectId,
      now: new Date("2026-07-30T09:00:00Z"),
      rebuild: false,
    });
    const tomorrow = await svc.runDailyMaintenance({
      projectId,
      now: new Date("2026-07-31T09:00:00Z"),
      rebuild: false,
    });
    expect(tomorrow.alreadyRan).toBe(false);
  });

  // -------------------------------------------------- reconcile, not rebuild

  it("does not rebuild pages it did not flag", async () => {
    // Twelve healthy pages, one stale past its SLA.
    for (let i = 0; i < 12; i += 1) {
      await sql`
        insert into wiki_pages (project_id, slug, page_type, title, stale, stale_since)
        values (${projectId}, ${`fresh-${i}`}, 'overview', ${`Fresh ${i}`}, false, null)
      `;
    }
    await sql`
      insert into wiki_pages (project_id, slug, page_type, title, stale, stale_since, stale_reason)
      values (${projectId}, 'rotten', 'overview', 'Rotten', true,
              now() - interval '3 days', 'claim changed')
    `;

    const run = await svc.runDailyMaintenance({
      projectId,
      now: new Date("2026-07-30T09:00:00Z"),
      rebuild: false,
    });

    // The whole point of the incremental engine: a daily job that rebuilt all
    // thirteen would hide the staleness it exists to detect.
    expect(run.pagesConsidered).toBeGreaterThanOrEqual(13);
    expect(run.pagesRebuilt).toBe(0);

    const raised = await sql`
      select subject_id from knowledge_exceptions where kind = 'stale_page'
    `;
    expect(raised).toHaveLength(1);
  });

  // -------------------------------------------------------------- detectors

  it("detects an approved claim with no evidence", async () => {
    await sql`
      insert into claims (project_id, key, canonical_text, status, evidence_ids)
      values (${projectId}, 'sales_volume', '$40M closed in 2025', 'approved', '{}')
    `;
    const result = await detectors.detectOrphanedClaims(projectId);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.summary).toContain("sales_volume");
    expect(result.findings[0]!.recommendedAction).toContain("withdraw the approval");
  });

  it("detects a claim citing evidence that no longer exists", async () => {
    const ghost = "00000000-0000-4000-8000-0000000000ff";
    await sql`
      insert into claims (project_id, key, canonical_text, status, evidence_ids)
      values (${projectId}, 'ranking', 'Top 10 in 2025', 'approved', ${[ghost]})
    `;
    const result = await detectors.detectBrokenEvidenceLinks(projectId);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.detail.missingEvidenceIds).toEqual([ghost]);
  });

  it("detects an expired claim and reports how overdue it is", async () => {
    await sql`
      insert into claims (project_id, key, canonical_text, status, review_date)
      values (${projectId}, 'brokerage', 'Affiliated with X', 'approved', current_date - 10)
    `;
    const result = await detectors.detectExpiredClaims(projectId);
    expect(result.findings).toHaveLength(1);
    expect(Number(result.findings[0]!.detail.daysOverdue)).toBe(10);
  });

  it("does not flag a failed ingestion that was superseded", async () => {
    await sql`
      insert into source_artifacts (project_id, source_type, mime_type, byte_size,
        sha256, storage_key, extraction_status, superseded_at)
      values (${projectId}, 'document', 'application/pdf', 10, 'h1', 'k1', 'failed', now())
    `;
    const result = await detectors.detectFailedIngestions(projectId);
    expect(result.findings).toHaveLength(0);
  });

  // ------------------------------------------------- exception lifecycle

  it("refreshes rather than duplicates a repeated finding", async () => {
    const raise = () =>
      sql.begin((tx) =>
        exceptions.raiseKnowledgeException(tx, {
          projectId,
          kind: "stale_page",
          subjectType: "wiki_page",
          subjectId: "00000000-0000-4000-8000-000000000abc",
          summary: "still stale",
        })
      );

    const first = await raise();
    expect(first.created).toBe(true);
    expect(first.occurrences).toBe(1);

    const second = await raise();
    expect(second.created).toBe(false);
    // The signal that matters is persistence, not recurrence.
    expect(second.occurrences).toBe(2);
    expect(second.id).toBe(first.id);

    const rows = await sql`select id from knowledge_exceptions where kind = 'stale_page'`;
    expect(rows).toHaveLength(1);
  });

  it("auto-resolves an exception whose subject no longer qualifies", async () => {
    const gone = "00000000-0000-4000-8000-000000000ddd";
    await sql.begin((tx) =>
      exceptions.raiseKnowledgeException(tx, {
        projectId,
        kind: "orphaned_claim",
        subjectType: "claim",
        subjectId: gone,
        summary: "no evidence",
      })
    );

    // The next run finds nothing: the feed must shrink without a human ticking
    // off a finding the system can see is fixed.
    const resolved = await sql.begin((tx) =>
      exceptions.autoResolveKnowledgeExceptions(tx, "orphaned_claim", [])
    );
    expect(resolved).toBe(1);

    const [row] = await sql`select status from knowledge_exceptions where subject_id = ${gone}`;
    expect(row!.status).toBe("resolved");
  });

  it("keeps an exception open while its subject still qualifies", async () => {
    const stillBad = "00000000-0000-4000-8000-000000000eee";
    await sql.begin((tx) =>
      exceptions.raiseKnowledgeException(tx, {
        projectId,
        kind: "orphaned_claim",
        subjectType: "claim",
        subjectId: stillBad,
        summary: "no evidence",
      })
    );
    const resolved = await sql.begin((tx) =>
      exceptions.autoResolveKnowledgeExceptions(tx, "orphaned_claim", [stillBad])
    );
    expect(resolved).toBe(0);
  });

  it("orders the feed worst-first", async () => {
    await sql.begin(async (tx) => {
      await exceptions.raiseKnowledgeException(tx, {
        projectId, kind: "unused_page", subjectType: "wiki_page",
        subjectId: "00000000-0000-4000-8000-000000000001", summary: "low",
      });
      await exceptions.raiseKnowledgeException(tx, {
        projectId, kind: "privacy_violation", subjectType: "context_packet",
        subjectId: "00000000-0000-4000-8000-000000000002", summary: "critical",
      });
    });
    const feed = await exceptions.openKnowledgeExceptions(projectId);
    expect(feed[0]!.severity).toBe("critical");
  });

  // ------------------------------------------------------ legal hold

  it("refuses to purge a source under legal hold, in the database", async () => {
    const [row] = await sql`
      insert into source_artifacts (project_id, source_type, mime_type, byte_size,
        sha256, storage_key, legal_hold, legal_hold_reason)
      values (${projectId}, 'document', 'application/pdf', 10, 'h2', 'k2', true, 'litigation')
      returning id
    `;
    const id = row!.id as string;

    // The purge path is the one legal hold guards. A WHERE clause that forgets
    // the hold is a silent breach; the trigger makes it a loud one.
    await expect(
      sql`update source_artifacts set purged_at = now() where id = ${id}`
    ).rejects.toThrow(/legal hold/i);

    // Hard deletion is blocked by something stronger and older: spec 021's
    // content-immutability trigger, which forbids DELETE on any source
    // artifact whether or not a hold exists. Asserted here so that if that
    // rule is ever relaxed, legal hold does not quietly become the only thing
    // standing between an unattended sweep and the evidence.
    await expect(sql`delete from source_artifacts where id = ${id}`).rejects.toThrow(
      /forbidden|immutable|legal hold/i
    );

    const [still] = await sql`select purged_at from source_artifacts where id = ${id}`;
    expect(still!.purgedAt).toBeNull();
  });

  it("allows a purge once the hold is cleared", async () => {
    const [row] = await sql`
      insert into source_artifacts (project_id, source_type, mime_type, byte_size,
        sha256, storage_key, legal_hold)
      values (${projectId}, 'document', 'application/pdf', 10, 'h3', 'k3', true)
      returning id
    `;
    const id = row!.id as string;
    await sql`update source_artifacts set legal_hold = false,
      legal_hold_reason = 'hold lifted 2026-07-30' where id = ${id}`;
    await sql`update source_artifacts set purged_at = now() where id = ${id}`;

    const [purged] = await sql`select purged_at from source_artifacts where id = ${id}`;
    expect(purged!.purgedAt).not.toBeNull();
  });

  it("surfaces retention-due sources without deleting anything", async () => {
    await sql`
      insert into source_artifacts (project_id, source_type, mime_type, byte_size,
        sha256, storage_key, retention_due_at)
      values (${projectId}, 'document', 'application/pdf', 10, 'h4', 'k4',
              now() - interval '1 day')
    `;
    const result = await detectors.detectRetentionDue(projectId);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.recommendedAction).toContain("never automatic");

    const rows = await sql`select id from source_artifacts where purged_at is null`;
    expect(rows).toHaveLength(1);
  });

  // ---------------------------------------------------------------- metrics

  it("reports null rather than zero for rates with no denominator", async () => {
    const health = await metrics.knowledgeHealth(projectId);
    // "No sources" must not read as "extraction is perfect".
    expect(health.ingestion.extractionFailureRate).toBeNull();
    expect(health.canonical.evidenceCoverage).toBeNull();
    expect(health.retrieval.crossClientLeakageRate).toBeNull();
    expect(health.agentQualityMeasured).toBe(false);
  });

  it("computes evidence coverage once claims exist", async () => {
    const [ev] = await sql`
      insert into evidence (kind, ref_id, note) values ('url', gen_random_uuid(), 'src')
      returning id
    `;
    await sql`
      insert into claims (project_id, key, canonical_text, status, evidence_ids)
      values (${projectId}, 'a', 'x', 'approved', ${[ev!.id as string]}),
             (${projectId}, 'b', 'y', 'approved', '{}')
    `;
    const canonical = await metrics.canonicalMetrics(projectId);
    expect(canonical.approved).toBe(2);
    expect(canonical.evidenceCoverage).toBe(0.5);
  });

  // ------------------------------------------------------- resilience

  it("finishes and reports partial when one check fails", async () => {
    // Break a table one detector reads; the rest must still report.
    await sql.unsafe("alter table knowledge_builds rename to knowledge_builds_hidden");
    try {
      const run = await svc.runDailyMaintenance({
        projectId,
        now: new Date("2026-07-30T11:00:00Z"),
        rebuild: false,
      });
      expect(run.status).toBe("partial");
      expect(run.checksFailed).toBeGreaterThan(0);
      // One broken query must not cost the operator every other finding.
      expect(run.checksRun).toBeGreaterThan(5);
      expect(run.detail.failedChecks).toBeDefined();
    } finally {
      await sql.unsafe("alter table knowledge_builds_hidden rename to knowledge_builds");
    }
  });

  it("records a weekly run separately from the daily one", async () => {
    const now = new Date("2026-07-30T09:00:00Z");
    await svc.runDailyMaintenance({ projectId, now, rebuild: false });
    const weekly = await svc.runWeeklyMaintenance({ projectId, now });

    expect(weekly.kind).toBe("weekly");
    expect(weekly.windowKey).toMatch(/^\d{4}-W\d{2}$/);
    // The weekly review never rebuilds: its findings are judgements.
    expect(weekly.pagesRebuilt).toBe(0);
  });
});
