"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Snowflake } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAction } from "@/lib/hooks/use-action";
import { freezePromptSet } from "@/app/prompts/actions";

interface Props {
  setId: string;
  nextVersion: number;
  promptCount: number;
  disabled: boolean;
}

export function FreezeButton({ setId, nextVersion, promptCount, disabled }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { pending, run } = useAction();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" disabled={disabled} title={disabled ? "Nothing new to freeze" : undefined}>
          <Snowflake className="size-4" /> Freeze v{nextVersion}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Freeze as version {nextVersion}?</AlertDialogTitle>
          <AlertDialogDescription>
            {promptCount} prompt{promptCount === 1 ? "" : "s"} will be
            snapshotted. Version {nextVersion} will be immutable forever —
            runs reference frozen versions, never the live set.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              run(
                async () => {
                  const result = await freezePromptSet({ id: setId });
                  // The dialog closes and the page refreshes on BOTH
                  // outcomes; the hook only refreshes on success.
                  setOpen(false);
                  if (!result.ok) router.refresh();
                  return result;
                },
                {
                  success: (data) => `Frozen as version ${data.version}.`,
                  refresh: true,
                }
              )
            }
          >
            {pending ? "Freezing…" : "Freeze"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
