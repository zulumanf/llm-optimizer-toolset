/**
 * Spec 035 — end-to-end prompt import: dedupe against existing rows,
 * provenance stamping, audit trail, archived-set refusal, zero-valid-rows
 * failure, brand-aware suggestions from the project's own registry.
 */
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000201",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("prompt import (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let importSvc: typeof import("@/lib/prompts/import");
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let companySvc: typeof import("@/lib/companies/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    importSvc = await import("@/lib/prompts/import");
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    companySvc = await import("@/lib/companies/service");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      "truncate audit_log, prompts, prompt_set_versions, prompt_sets, companies, projects cascade"
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedSet(): Promise<{ projectId: string; setId: string }> {
    await companySvc.upsertCompany(user, { name: "Lumina", isSelf: true });
    const project = await projectSvc.createProject(user, { name: "Import Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Imported",
    });
    if (!set.ok) throw new Error(set.error.message);
    return { projectId: project.data.id, setId: set.data.id };
  }

  it("imports, dedupes against existing prompts and within the batch, stamps provenance", async () => {
    const { setId } = await seedSet();
    await promptSvc.addPrompt(user, {
      setId,
      text: "Best CRM for solo agents",
      category: "recommendation",
    });

    const result = await importSvc.importPrompts(user, {
      setId,
      content: [
        "best crm   for solo agents", // dup of existing (case/space-insensitive)
        "HubSpot vs Salesforce",
        "hubspot vs salesforce", // dup within batch
        "Is Lumina legit?", // branded via the project registry
      ].join("\n"),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({
      added: 2,
      skippedDuplicates: 2,
      format: "lines",
    });
    expect(result.data.rejected).toHaveLength(0);

    const rows = await sql`
      select text, category, source, position from prompts
      where prompt_set_id = ${setId} and archived_at is null
      order by position
    `;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.source).toBe("manual");
    expect(rows[1]).toMatchObject({ category: "comparison", source: "import" });
    expect(rows[2]).toMatchObject({ category: "branded", source: "import" });

    const [audit] = await sql`
      select detail from audit_log
      where action = 'prompt.import' and entity_id = ${setId}
    `;
    expect(audit?.detail).toMatchObject({ added: 2, skippedDuplicates: 2 });

    // Re-importing identical content adds nothing.
    const again = await importSvc.importPrompts(user, {
      setId,
      content: "HubSpot vs Salesforce",
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.data.added).toBe(0);
      expect(again.data.skippedDuplicates).toBe(1);
    }
  });

  it("zero importable rows is a failure that names the first reason", async () => {
    const { setId } = await seedSet();
    const result = await importSvc.importPrompts(user, {
      setId,
      content: "Jersey City waterfront condos",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("validation");
      expect(result.error.message).toContain("no classification rule matched");
    }
    const countRows = await sql<{ count: number }[]>`
      select count(*)::int as count from prompts
    `;
    expect(countRows[0]?.count).toBe(0);
  });

  it("refuses archived sets", async () => {
    const { setId } = await seedSet();
    await setSvc.archivePromptSet(user, { id: setId });
    const result = await importSvc.importPrompts(user, {
      setId,
      content: "Best CRM for solo agents",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("conflict");
  });
});
