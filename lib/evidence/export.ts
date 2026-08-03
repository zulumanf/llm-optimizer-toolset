/**
 * Evidence export packages (evidence spec): a per-run directory —
 * manifest.json, methodology.md, observations.csv, classifications.csv,
 * sources.csv, audit-history.csv, raw-responses/*.json — packed with the
 * system tar into a .tar.gz whose sha256 is recorded. A recipient verifies
 * every file against manifest hashes; observations.csv reproduces the
 * reported metrics by counting rows.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { drilldown, DRILLDOWN_METRICS } from "@/lib/evidence/observations";
import { artifactPath } from "@/lib/evidence/storage";
import { SCORING_VERSION } from "@/lib/constants";

const execFileAsync = promisify(execFile);

function csvEscape(value: unknown): string {
  const s = value == null ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [
    headers.join(","),
    ...rows.map((r) => r.map(csvEscape).join(",")),
  ].join("\n");
}

export async function generateEvidenceExport(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ exportId: string; storageKey: string; sha256: string }>> {
  assertCanWrite(user);
  const parsed = z.object({ runId: z.string().uuid() }).safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid run id."));
  }
  const { runId } = parsed.data;
  try {
    const [run] = await sql`
      select r.id, r.label, r.project_id, r.started_at, r.completed_at,
        v.version as set_version, s.name as set_name
      from runs r
      join prompt_set_versions v on v.id = r.prompt_set_version_id
      join prompt_sets s on s.id = v.prompt_set_id
      where r.id = ${runId}
    `;
    if (!run) return fail(new ClassifiedError("not_found", "Run not found."));

    const [exportRow] = await sql`
      insert into evidence_exports (run_id, requested_by)
      values (${runId}, ${user.id}) returning id
    `;
    const exportId = exportRow?.id as string;
    const storageKey = `exports/${exportId}.tar.gz`;
    const workDir = artifactPath(`exports/${exportId}`);
    const packageDir = join(workDir, "evidence-package");
    await mkdir(join(packageDir, "raw-responses"), { recursive: true });

    // --- observations.csv + raw responses ---
    const responses = await sql`
      select id, prompt_id, prompt_text, provider, model, repetition, refusal,
        latency_ms, tokens_in, tokens_out, cost_usd, error, response_text,
        raw_payload, response_hash, payload_hash, hashed_at, requested_at
      from responses where run_id = ${runId} order by requested_at asc
    `;
    const observationRows = responses.map((r) => [
      r.id, r.promptId, r.promptText, r.provider, r.model, r.repetition,
      r.refusal, r.error ? "capture_failed" : "captured", r.responseHash,
      r.payloadHash,
      r.requestedAt instanceof Date ? r.requestedAt.toISOString() : r.requestedAt,
    ]);
    for (const r of responses) {
      await writeFile(
        join(packageDir, "raw-responses", `${r.id}.json`),
        JSON.stringify(
          {
            observationId: r.id,
            promptText: r.promptText,
            provider: r.provider,
            model: r.model,
            responseText: r.responseText,
            rawPayload: r.rawPayload,
            responseHash: r.responseHash,
            payloadHash: r.payloadHash,
            error: r.error ?? null,
          },
          null,
          2
        )
      );
    }

    // --- classifications.csv (every revision — full history) ---
    const classifications = await sql`
      select m.response_id, c.name as company, m.revision, m.mentioned,
        m.recommended, m.list_position, m.sentiment, m.confidence,
        m.needs_review, m.parser_version, m.created_at
      from mentions m
      join companies c on c.id = m.company_id
      join responses r on r.id = m.response_id
      where r.run_id = ${runId}
      order by m.response_id, c.name, m.revision
    `;
    // --- sources.csv --- (this client's registry only; migration 029 scoped
    // sources per project so an export never carries another client's counts)
    const sourceRows = await sql`
      select s.url, s.domain, c.name as attributed_company, s.citation_count
      from sources s left join companies c on c.id = s.company_id
      where s.project_id = (select project_id from runs where id = ${runId})
      order by s.citation_count desc
    `;
    // --- audit-history.csv (run-scoped) ---
    const audits = await sql`
      select a.at, a.action, a.entity, a.entity_id, a.detail, a.user_id
      from audit_log a
      where a.entity_id = ${runId}
        or a.entity_id in (select id from responses where run_id = ${runId})
      order by a.at asc
    `;

    // The parser version(s) that actually classified this run, read from the
    // rows themselves — a run parsed by v2+llm must never be manifested as
    // v1. Plural because a re-parse under a newer version leaves both in the
    // revision history, and the export contains every revision.
    const parserVersions = [
      ...new Set(classifications.map((m) => m.parserVersion as string)),
    ].sort();
    const parserVersionLabel =
      parserVersions.length > 0 ? parserVersions.join(", ") : "none (unparsed run)";

    // --- metric summary (numerator/denominator per drill-down) ---
    const metricSummaries = [];
    for (const metric of DRILLDOWN_METRICS) {
      const result = await drilldown({
        runId,
        metric,
        scoringVersion: SCORING_VERSION,
      });
      if (result) {
        metricSummaries.push({
          metric,
          company: result.companyName,
          numerator: result.numerator,
          denominator: result.denominator,
          value: result.value,
          matchesStoredScore: result.matchesStored,
        });
      }
    }

    const files: Record<string, string> = {
      "observations.csv": toCsv(
        ["observation_id", "prompt_id", "prompt_text", "provider", "model",
         "repetition", "refusal", "status", "response_hash", "payload_hash",
         "captured_at"],
        observationRows
      ),
      "classifications.csv": toCsv(
        ["observation_id", "company", "revision", "mentioned", "recommended",
         "list_position", "sentiment", "confidence", "needs_review",
         "parser_version", "created_at"],
        classifications.map((m) => [
          m.responseId, m.company, m.revision, m.mentioned, m.recommended,
          m.listPosition, m.sentiment, m.confidence, m.needsReview,
          m.parserVersion,
          m.createdAt instanceof Date ? m.createdAt.toISOString() : m.createdAt,
        ])
      ),
      "sources.csv": toCsv(
        ["url", "domain", "attributed_company", "citation_count"],
        sourceRows.map((s) => [s.url, s.domain, s.attributedCompany, s.citationCount])
      ),
      "audit-history.csv": toCsv(
        ["at", "actor", "action", "entity", "entity_id", "detail"],
        audits.map((a) => [
          a.at instanceof Date ? a.at.toISOString() : a.at,
          a.userId, a.action, a.entity, a.entityId, JSON.stringify(a.detail),
        ])
      ),
      "benchmark-summary.csv": toCsv(
        ["metric", "company", "numerator", "denominator", "value",
         "matches_stored_score"],
        metricSummaries.map((m) => [
          m.metric, m.company, m.numerator, m.denominator,
          m.value == null ? "" : m.value.toFixed(6), m.matchesStoredScore,
        ])
      ),
      "methodology.md": [
        `# Methodology`,
        ``,
        `- Benchmark: ${run.setName} v${run.setVersion} (frozen prompt set — prompts immutable per version)`,
        `- Run: ${run.label} (${runId})`,
        `- Scoring version: ${SCORING_VERSION} · Parser version(s): ${parserVersionLabel}`,
        `- Eligible observation: successful capture (refusals count, errors do not), non-holdout prompt.`,
        `- Mention/recommendation/citation rates = positive observations / eligible observations; numerators and denominators are in benchmark-summary.csv and reproducible by counting observations.csv joined to classifications.csv (latest revision per observation+company).`,
        `- Raw evidence is immutable at the database level; every response and payload carries a SHA-256 computed at capture. Verify: sha256(raw-responses/<id>.json field responseText bytes) == response_hash.`,
        `- Full definitions: docs/06-scoring-methodology.md at the versions above.`,
      ].join("\n"),
    };
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(packageDir, name), content);
    }

    // --- manifest with per-file hashes (raw responses included) ---
    const manifestFiles: { path: string; sha256: string; bytes: number }[] = [];
    const hashFile = async (relPath: string) => {
      const bytes = await readFile(join(packageDir, relPath));
      manifestFiles.push({
        path: relPath,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
      });
    };
    for (const name of Object.keys(files)) await hashFile(name);
    for (const r of responses) await hashFile(join("raw-responses", `${r.id}.json`));

    const manifest = {
      exportId,
      runId,
      runLabel: run.label,
      benchmark: `${run.setName} v${run.setVersion}`,
      scoringVersion: SCORING_VERSION,
      parserVersions,
      observationCount: responses.length,
      metrics: metricSummaries,
      files: manifestFiles,
      createdBy: user.email,
    };
    await writeFile(
      join(packageDir, "manifest.json"),
      JSON.stringify(manifest, null, 2)
    );

    await execFileAsync("tar", ["-czf", artifactPath(storageKey), "-C", workDir,
      "evidence-package"]);
    const tarBytes = await readFile(artifactPath(storageKey));
    const sha256 = createHash("sha256").update(tarBytes).digest("hex");

    await sql.begin(async (tx) => {
      await tx`
        update evidence_exports set status = 'completed',
          storage_key = ${storageKey}, sha256 = ${sha256},
          manifest = ${tx.json(manifest as never)}, completed_at = now()
        where id = ${exportId}
      `;
      await writeAudit(tx, {
        userId: user.id,
        action: "evidence.export",
        entity: "run",
        entityId: runId,
        detail: { exportId, files: manifestFiles.length, sha256 },
      });
    });
    return ok({ exportId, storageKey, sha256 });
  } catch (err) {
    return fail(err);
  }
}
