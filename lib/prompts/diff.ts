import type { FrozenPrompt } from "@/lib/prompts/types";

export interface VersionDiff {
  added: FrozenPrompt[];
  removed: FrozenPrompt[];
  changed: { before: FrozenPrompt; after: FrozenPrompt }[];
  unchangedCount: number;
}

/**
 * Diff two frozen snapshots (spec 002 version view). Prompts are matched by
 * promptId — a reworded prompt shows as changed, a replaced one as
 * removed + added.
 */
export function diffVersions(
  before: FrozenPrompt[],
  after: FrozenPrompt[]
): VersionDiff {
  const beforeById = new Map(before.map((p) => [p.promptId, p]));
  const afterById = new Map(after.map((p) => [p.promptId, p]));

  const added = after.filter((p) => !beforeById.has(p.promptId));
  const removed = before.filter((p) => !afterById.has(p.promptId));
  const changed: VersionDiff["changed"] = [];
  let unchangedCount = 0;

  for (const b of before) {
    const a = afterById.get(b.promptId);
    if (!a) continue;
    if (
      a.text !== b.text ||
      a.category !== b.category ||
      a.language !== b.language
    ) {
      changed.push({ before: b, after: a });
    } else {
      unchangedCount += 1;
    }
  }

  return { added, removed, changed, unchangedCount };
}
