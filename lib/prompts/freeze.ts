import type { FrozenPrompt } from "@/lib/prompts/types";

/**
 * Freeze identity (spec 002): two snapshots are the same content when their
 * ordered lists of (text, category, language) match. Prompt ids and raw
 * position values are irrelevant — order is what runs experience.
 */
export function isSameContent(a: FrozenPrompt[], b: FrozenPrompt[]): boolean {
  if (a.length !== b.length) return false;
  const ordered = (list: FrozenPrompt[]) =>
    [...list].sort((x, y) => x.position - y.position);
  const as = ordered(a);
  const bs = ordered(b);
  return as.every((p, i) => {
    const q = bs[i];
    return (
      q !== undefined &&
      p.text === q.text &&
      p.category === q.category &&
      p.language === q.language
    );
  });
}
