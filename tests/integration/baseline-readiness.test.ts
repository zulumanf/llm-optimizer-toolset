/**
 * Spec 160 A1: baseline readiness counts exactly what is incomplete, on the
 * same cell space run execution and "Retry failed" use. Responses are
 * insert-only, so a cell's history can hold a failed attempt AND a later
 * success — that cell is answered, not outstanding.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const user: CurrentUser = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };

describe.skipIf(!TEST_URL)("spec 160: baseline readiness (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
    await seedTestActors(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  it("counts outstanding, unrecognised and empty answers; a failed-then-retried cell is answered; an empty refusal is a valid answer", async () => {
    const projectSvc = await import("@/lib/projects/service");
    const setSvc = await import("@/lib/prompts/set-service");
    const promptSvc = await import("@/lib/prompts/prompt-service");
    const runSvc = await import("@/lib/runs/service");
    const { baselineReadiness } = await import("@/lib/engagements/measurement");

    const project = unwrap(await projectSvc.createProject(user, { name: "Readiness" }));
    const set = unwrap(await setSvc.createPromptSet(user, { projectId: project.id, name: "Set" }));
    const texts = ["retried question", "unrecognised question", "empty question", "refused question", "failing question"];
    for (const text of texts) unwrap(await promptSvc.addPrompt(user, { setId: set.id, text, category: "recommendation" }));
    unwrap(await setSvc.freezePromptSet(user, { id: set.id }));
    const [version] = await sql`select id, frozen_prompts from prompt_set_versions where prompt_set_id = ${set.id}`;
    const ids = Object.fromEntries((version!.frozenPrompts as { promptId: string; text: string }[]).map((p) => [p.text, p.promptId]));
    const run = unwrap(await runSvc.startRun(user, { projectId: project.id, promptSetVersionId: version!.id as string, providers: [{ provider: "mock", model: "mock-model", repetitions: 1 }], budgetUsd: 5, label: "readiness" }));
    await sql`update runs set status = 'partial' where id = ${run.id}`;

    const insert = (text: string, f: { responseText?: string | null; error?: object | null; refusal?: boolean; shapeRecognized?: boolean | null }) => sql`
      insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text, refusal, error, shape_recognized)
      values (${run.id}, ${ids[text]!}, ${text}, 'mock', 'mock-model', 1, ${f.responseText ?? null}, ${f.refusal ?? false},
        ${f.error ? sql.json(f.error as never) : null}, ${f.shapeRecognized ?? null})
    `;
    // Failed first, then succeeded on retry: answered.
    await insert("retried question", { error: { kind: "rate_limited" } });
    await insert("retried question", { responseText: "Lumina is a good choice.", shapeRecognized: true });
    await insert("unrecognised question", { responseText: "", shapeRecognized: false });
    await insert("empty question", { responseText: "   ", shapeRecognized: true });
    await insert("refused question", { responseText: "", refusal: true, shapeRecognized: true });
    // Only failures: outstanding.
    await insert("failing question", { error: { kind: "provider_error" } });
    await insert("failing question", { error: { kind: "provider_error" } });

    const r = await baselineReadiness(run.id, "mock");
    expect(r).toMatchObject({
      expectedCells: 5,
      outstandingCells: 1,
      validAnswers: 4,
      unrecognized: 1,
      empty: 2, // the whitespace answer and the unrecognised one (no text either); never the refusal
      reused: 0,
      unparsed: 4,
    });
    const text = r.blockers.join(" ");
    expect(text).toMatch(/1 of 5 question cell\(s\) have no successful answer/);
    expect(text).toMatch(/1 answer\(s\) had a response shape the capture did not recognise/);
    expect(text).toMatch(/2 answer\(s\) are empty/);
    expect(r.warnings).toEqual([]);
  });
});
