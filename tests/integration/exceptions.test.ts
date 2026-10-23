/** Spec 151 C3: the exception queue surfaces stalls across clients. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { clientViewerUser, operatorUser } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("exception queue (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let ex: typeof import("@/lib/operations/exceptions");
  const previousOllama = process.env.OLLAMA_URL;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    ex = await import("@/lib/operations/exceptions");
    // Nothing listens on port 1: the promoted-task host is unreachable.
    process.env.OLLAMA_URL = "http://127.0.0.1:1";
  });
  afterAll(async () => {
    if (previousOllama === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = previousOllama;
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
  });

  it("lists failed and over-budget runs, failed jobs, stale reviews and an unreachable inference host — staff only", async () => {
    const [project] = await sql`insert into projects (name) values ('Exc Client') returning id`;
    const [company] = await sql`insert into companies (name) values ('Co') returning id`;
    const [set] = await sql`insert into prompt_sets (project_id, name) values (${project!.id}, 'S') returning id`;
    const [version] = await sql`insert into prompt_set_versions (prompt_set_id, version, frozen_prompts) values (${set!.id}, 1, '[]') returning id`;
    await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, status_detail, trigger, budget_usd)
      values (${project!.id}, ${version!.id}, 'broken', '[]', 'failed', 'quota', 'manual', 5)
    `;
    const [costly] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd, cost_usd)
      values (${project!.id}, ${version!.id}, 'costly', '[]', 'completed', 'manual', 1, 3) returning id
    `;
    const [resp] = await sql`
      insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text)
      values (${costly!.id}, gen_random_uuid(), 'q', 'openai', 'm', 1, 'a') returning id
    `;
    await sql`
      insert into mentions (response_id, company_id, mentioned, parser_version, confidence, needs_review, created_at)
      values (${resp!.id}, ${company!.id}, true, 'mention-parser-v2+llm', 0.4, true, now() - interval '3 days')
    `;
    await sql`insert into jobs (type, payload, status) values ('compute_scores', '{}', 'failed')`;

    const items = await ex.exceptionQueue(operatorUser());
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(["failed_run", "over_budget_run", "pending_review", "failed_job", "internal_inference_unreachable"]));
    // High severity sorts first.
    expect(items[0]?.severity).toBe("high");
    await expect(ex.exceptionQueue(clientViewerUser())).rejects.toThrow(/read-only/);
  });

  it("alerts on a failed or stale backup, and is quiet after a fresh success", async () => {
    await sql`insert into backup_runs (started_at, finished_at, ok, encrypted, uploaded) values (now() - interval '30 hours', now() - interval '30 hours', true, true, true)`;
    let kinds = (await ex.exceptionQueue(operatorUser())).map((i) => i.kind);
    expect(kinds).toContain("backup_stale");
    await sql`insert into backup_runs (started_at, ok, encrypted, uploaded) values (now(), true, true, true)`;
    kinds = (await ex.exceptionQueue(operatorUser())).map((i) => i.kind);
    expect(kinds).not.toContain("backup_stale");
    await sql`insert into backup_runs (started_at, ok, encrypted, uploaded, note) values (now(), false, true, false, 'upload failed')`;
    kinds = (await ex.exceptionQueue(operatorUser())).map((i) => i.kind);
    expect(kinds).toContain("backup_stale");
  });

  it("is empty for a healthy system apart from infrastructure checks", async () => {
    const items = await ex.exceptionQueue(operatorUser());
    expect(items.filter((i) => i.kind !== "internal_inference_unreachable")).toEqual([]);
  });
});
