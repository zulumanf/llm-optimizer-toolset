"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { archivePrompt, reorderPrompts } from "@/app/prompts/actions";
import { PromptFormDialog } from "@/components/prompts/prompt-form-dialog";
import type { PromptCategory } from "@/lib/constants";

interface Props {
  prompt: { id: string; promptSetId: string; text: string; category: PromptCategory };
  orderedIds: string[];
  index: number;
}

export function PromptRowControls({ prompt, orderedIds, index }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const move = (delta: -1 | 1) => {
    const next = [...orderedIds];
    const swap = index + delta;
    const a = next[index];
    const b = next[swap];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[swap] = a;
    startTransition(async () => {
      const result = await reorderPrompts({
        setId: prompt.promptSetId,
        orderedPromptIds: next,
      });
      if (result.ok) router.refresh();
      else toast.error(result.error.message);
    });
  };

  const archive = () => {
    startTransition(async () => {
      const result = await archivePrompt({ promptId: prompt.id });
      if (result.ok) {
        toast.success("Prompt archived. It stays visible in old versions.");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Move up"
        disabled={pending || index === 0}
        onClick={() => move(-1)}
      >
        <ArrowUp className="size-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Move down"
        disabled={pending || index === orderedIds.length - 1}
        onClick={() => move(1)}
      >
        <ArrowDown className="size-4" />
      </Button>
      <PromptFormDialog mode="edit" prompt={prompt} />
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Archive prompt"
        disabled={pending}
        onClick={archive}
      >
        <Archive className="size-4" />
      </Button>
    </div>
  );
}
