/**
 * Integration tests for spec 002 against a real Postgres.
 * Covers: freeze snapshot fidelity and immutability, no-change/empty freeze
 * guards, concurrent freeze race, sequential numbering, reorder staleness,
 * archived-prompt exclusion, duplicate-from-version.
 */
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { FrozenPrompt } from "@/lib/prompts/types";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000cc",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("prompt library (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let sets: typeof import("@/lib/prompts/set-service");
  let promptsSvc: typeof import("@/lib/prompts/prompt-service");
  let dbq: typeof import("@/db/prompt-sets");
  let projectId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    sets = await import("@/lib/prompts/set-service");
    promptsSvc = await import("@/lib/prompts/prompt-service");
    dbq = await import("@/db/prompt-sets");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      "truncate audit_log, prompt_set_versions, prompts, prompt_sets, projects cascade"
    );
    const [p] = await sql`
      insert into projects (name) values ('Test Project') returning id
    `;
    projectId = p?.id as string;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function makeSetWithPrompts(
    texts: string[]
  ): Promise<{ setId: string; promptIds: string[] }> {
    const created = await sets.createPromptSet(user, {
      projectId,
      name: `Set ${Math.abs(texts.join("").length)}-${texts[0] ?? "empty"}`,
    });
    if (!created.ok) throw new Error(created.error.message);
    const promptIds: string[] = [];
    for (const text of texts) {
      const added = await promptsSvc.addPrompt(user, {
        setId: created.data.id,
        text,
        category: "recommendation",
      });
      if (!added.ok) throw new Error(added.error.message);
      promptIds.push(added.data.id);
    }
    return { setId: created.data.id, promptIds };
  }

  it("freeze snapshots content immutably: later edits leave the version untouched", async () => {
    const { setId, promptIds } = await makeSetWithPrompts(["What is best?", "Compare A vs B"]);
    const frozen = await sets.freezePromptSet(user, { id: setId });
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    expect(frozen.data.version).toBe(1);

    await promptsSvc.updatePrompt(user, {
      promptId: promptIds[0],
      text: "Completely reworded",
    });
    await promptsSvc.archivePrompt(user, { promptId: promptIds[1]! });

    const v1 = await dbq.getVersion(setId, 1);
    expect(v1?.frozenPrompts.map((p: FrozenPrompt) => p.text)).toEqual([
      "What is best?",
      "Compare A vs B",
    ]);
  });

  it("blocks freezing an empty set and a no-change freeze", async () => {
    const { setId, promptIds } = await makeSetWithPrompts(["Only prompt"]);

    const first = await sets.freezePromptSet(user, { id: setId });
    expect(first.ok).toBe(true);

    const noChange = await sets.freezePromptSet(user, { id: setId });
    expect(noChange.ok).toBe(false);
    if (!noChange.ok) {
      expect(noChange.error.kind).toBe("conflict");
      expect(noChange.error.message).toMatch(/No changes since version 1/);
    }

    await promptsSvc.archivePrompt(user, { promptId: promptIds[0]! });
    const empty = await sets.freezePromptSet(user, { id: setId });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error.kind).toBe("validation");
  });

  it("versions are immutable at the DB level and numbered sequentially", async () => {
    const { setId, promptIds } = await makeSetWithPrompts(["v1 text"]);
    await sets.freezePromptSet(user, { id: setId });
    await promptsSvc.updatePrompt(user, { promptId: promptIds[0], text: "v2 text" });
    const second = await sets.freezePromptSet(user, { id: setId });
    expect(second.ok && second.data.version === 2).toBe(true);

    await expect(
      sql`update prompt_set_versions set version = 99`
    ).rejects.toThrow(/insert-only/);
    await expect(sql`delete from prompt_set_versions`).rejects.toThrow(
      /insert-only/
    );
  });

  it("concurrent freezes: exactly one wins, the loser gets a conflict", async () => {
    const { setId } = await makeSetWithPrompts(["race prompt"]);
    const [a, b] = await Promise.all([
      sets.freezePromptSet(user, { id: setId }),
      sets.freezePromptSet(user, { id: setId }),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    const conflicts = [a, b].filter((r) => !r.ok && r.error.kind === "conflict");
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    const versions = await dbq.listVersionSummaries(setId);
    expect(versions).toHaveLength(1);
  });

  it("reorder persists and rejects a stale prompt id list", async () => {
    const { setId, promptIds } = await makeSetWithPrompts(["one", "two", "three"]);
    const reversed = [...promptIds].reverse();
    const ok = await promptsSvc.reorderPrompts(user, {
      setId,
      orderedPromptIds: reversed,
    });
    expect(ok.ok).toBe(true);
    const after = await dbq.listActivePrompts(setId);
    expect(after.map((p) => p.text)).toEqual(["three", "two", "one"]);

    const stale = await promptsSvc.reorderPrompts(user, {
      setId,
      orderedPromptIds: promptIds.slice(0, 2),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.kind).toBe("conflict");
  });

  it("archived prompts are excluded from the next freeze but remain in old versions", async () => {
    const { setId, promptIds } = await makeSetWithPrompts(["keep", "drop"]);
    await sets.freezePromptSet(user, { id: setId });
    await promptsSvc.archivePrompt(user, { promptId: promptIds[1]! });
    const second = await sets.freezePromptSet(user, { id: setId });
    expect(second.ok).toBe(true);

    const v1 = await dbq.getVersion(setId, 1);
    const v2 = await dbq.getVersion(setId, 2);
    expect(v1?.frozenPrompts).toHaveLength(2);
    expect(v2?.frozenPrompts).toHaveLength(1);
    expect(v2?.frozenPrompts[0]?.text).toBe("keep");
  });

  it("duplicate name for an active set in the same project is rejected", async () => {
    await sets.createPromptSet(user, { projectId, name: "Core" });
    const dup = await sets.createPromptSet(user, { projectId, name: "  core " });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.kind).toBe("conflict");
  });

  it("duplicating from a version seeds a new set with the frozen content, no versions", async () => {
    const { setId, promptIds } = await makeSetWithPrompts(["original wording"]);
    await sets.freezePromptSet(user, { id: setId });
    await promptsSvc.updatePrompt(user, {
      promptId: promptIds[0],
      text: "diverged wording",
    });
    const v1 = await dbq.getVersion(setId, 1);

    const copy = await sets.duplicatePromptSet(user, {
      versionId: v1?.id,
      newName: "Seeded from v1",
    });
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;

    const copiedPrompts = await dbq.listActivePrompts(copy.data.id);
    expect(copiedPrompts.map((p) => p.text)).toEqual(["original wording"]);
    expect(await dbq.listVersionSummaries(copy.data.id)).toHaveLength(0);
  });

  it("blocks edits and freezes on archived sets", async () => {
    const { setId } = await makeSetWithPrompts(["locked"]);
    await sets.archivePromptSet(user, { id: setId });

    const add = await promptsSvc.addPrompt(user, {
      setId,
      text: "nope",
      category: "problem",
    });
    expect(add.ok).toBe(false);
    if (!add.ok) expect(add.error.kind).toBe("conflict");

    const freeze = await sets.freezePromptSet(user, { id: setId });
    expect(freeze.ok).toBe(false);
    if (!freeze.ok) expect(freeze.error.kind).toBe("conflict");
  });
});
