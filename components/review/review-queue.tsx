"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCheck, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ReviewCard } from "@/components/review/review-card";
import { bulkConfirmMentions } from "@/app/classification/actions";
import type { ReviewQueueItem } from "@/db/mentions";

/**
 * Review queue with batching (UX pass): scoring stays blocked until this is
 * clear, so throughput here is the operator's real constraint at agency
 * scale. Selection + keyboard navigation turn a fifty-click chore into a few
 * keystrokes, without weakening the per-item audit trail.
 *
 * Keys: j/k move · x toggles select · c confirms selection (or the focused
 * row when nothing is selected) · a selects all in the focused group.
 */
export function ReviewQueue({ items }: { items: ReviewQueueItem[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);

  /** Group identical decisions so one action can clear many rows: same
   * company + same classification shape = the same judgement. */
  const groups = useMemo(() => {
    const byKey = new Map<string, ReviewQueueItem[]>();
    for (const item of items) {
      const key = `${item.companyName}|${item.mentioned ? "m" : "-"}${
        item.recommended ? "r" : "-"
      }|${item.sentiment}`;
      byKey.set(key, [...(byKey.get(key) ?? []), item]);
    }
    return [...byKey.entries()].map(([key, groupItems]) => ({ key, items: groupItems }));
  }, [items]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirm = (ids: string[]) => {
    if (ids.length === 0) return;
    startTransition(async () => {
      const result = await bulkConfirmMentions({ mentionIds: ids });
      if (result.ok) {
        const { confirmed, skipped } = result.data;
        toast.success(
          `${confirmed} confirmed${skipped > 0 ? ` · ${skipped} skipped (superseded)` : ""}`
        );
        setSelected(new Set());
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never hijack typing in a correction form
      if (
        target &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
      ) {
        return;
      }
      if (event.key === "j") {
        setFocusIndex((i) => Math.min(i + 1, flat.length - 1));
      } else if (event.key === "k") {
        setFocusIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === "x") {
        const item = flat[focusIndex];
        if (item) toggle(item.id);
      } else if (event.key === "c") {
        const ids =
          selected.size > 0
            ? [...selected]
            : flat[focusIndex]
              ? [flat[focusIndex]!.id]
              : [];
        confirm(ids);
      } else if (event.key === "a") {
        const item = flat[focusIndex];
        const group = groups.find((g) => g.items.some((i) => i.id === item?.id));
        if (group) setSelected(new Set(group.items.map((i) => i.id)));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat, focusIndex, selected, groups]);

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-md border bg-card/95 p-3 backdrop-blur">
        <Button
          size="sm"
          disabled={pending || selected.size === 0}
          onClick={() => confirm([...selected])}
        >
          <CheckCheck className="size-4" />
          {pending
            ? "Confirming…"
            : `Confirm ${selected.size > 0 ? selected.size : "selected"}`}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending || items.length === 0}
          onClick={() => setSelected(new Set(flat.map((i) => i.id)))}
        >
          Select all ({items.length})
        </Button>
        {selected.size > 0 && (
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        )}
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Keyboard className="size-3.5" />
          j/k move · x select · a select group · c confirm
        </span>
      </div>

      {groups.map((group) => {
        const groupIds = group.items.map((i) => i.id);
        const allSelected = groupIds.every((id) => selected.has(id));
        const [sample] = group.items;
        return (
          <section key={group.key}>
            {group.items.length > 1 && (
              <div className="mb-2 flex items-center gap-2 text-sm">
                <Badge variant="secondary">
                  {group.items.length} identical judgements
                </Badge>
                <span className="text-muted-foreground">
                  {sample?.companyName} · {sample?.mentioned ? "mentioned" : "absent"}
                  {sample?.recommended ? " · recommended" : ""} · {sample?.sentiment}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  disabled={pending}
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const id of groupIds) {
                        if (allSelected) next.delete(id);
                        else next.add(id);
                      }
                      return next;
                    })
                  }
                >
                  {allSelected ? "Deselect group" : "Select group"}
                </Button>
              </div>
            )}
            <div className="space-y-3">
              {group.items.map((item) => {
                const index = flat.findIndex((i) => i.id === item.id);
                return (
                  <div
                    key={item.id}
                    className={`flex gap-3 rounded-md ${
                      index === focusIndex ? "ring-2 ring-ring ring-offset-2" : ""
                    }`}
                  >
                    <label className="flex items-start pt-4 pl-1">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        aria-label={`Select classification for ${item.companyName}`}
                      />
                    </label>
                    <div className="min-w-0 flex-1" onClick={() => setFocusIndex(index)}>
                      <ReviewCard item={item} />
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
