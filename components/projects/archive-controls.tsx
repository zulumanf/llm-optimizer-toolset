"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive, ArchiveRestore } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { archiveProject, unarchiveProject } from "@/app/projects/actions";

interface Props {
  project: { id: string; name: string; status: "active" | "archived" };
  isAdmin: boolean;
}

export function ArchiveControls({ project, isAdmin }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [pending, startTransition] = useTransition();

  if (!isAdmin) return null;

  if (project.status === "archived") {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await unarchiveProject({ id: project.id });
            if (result.ok) {
              toast.success("Project unarchived.");
              router.refresh();
            } else {
              toast.error(result.error.message);
            }
          })
        }
      >
        <ArchiveRestore className="size-4" /> Unarchive
      </Button>
    );
  }

  const confirmed = typed === project.name;

  return (
    <AlertDialog open={open} onOpenChange={(o) => { setOpen(o); setTyped(""); }}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="destructive">
          <Archive className="size-4" /> Archive
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive project &ldquo;{project.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            The project leaves active views. No data is deleted — it can be
            unarchived later. Type the project name to confirm.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-name">Project name</Label>
          <Input
            id="confirm-name"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={project.name}
          />
        </div>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!confirmed || pending}
            onClick={() =>
              startTransition(async () => {
                const result = await archiveProject({ id: project.id });
                if (result.ok) {
                  toast.success("Project archived.");
                  setOpen(false);
                  router.refresh();
                } else {
                  toast.error(result.error.message);
                }
              })
            }
          >
            {pending ? "Archiving…" : "Archive"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
