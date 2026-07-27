"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Plus, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createPromptSet, updatePromptSet } from "@/app/prompts/actions";
import { SET_NAME_MAX, SET_DESCRIPTION_MAX } from "@/lib/constants";

const formSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(SET_NAME_MAX),
  description: z.string().trim().max(SET_DESCRIPTION_MAX).optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
  mode: "create" | "edit";
  projectId?: string;
  set?: { id: string; name: string; description: string | null };
}

export function SetFormDialog({ mode, projectId, set }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: { name: set?.name ?? "", description: set?.description ?? "" },
  });

  const onSubmit = (values: FormValues) => {
    startTransition(async () => {
      const result =
        mode === "create"
          ? await createPromptSet({ projectId, ...values })
          : await updatePromptSet({ id: set?.id, ...values });
      if (result.ok) {
        toast.success(mode === "create" ? "Prompt set created." : "Prompt set updated.");
        setOpen(false);
        reset();
        if (mode === "create") {
          router.push(`/projects/${projectId}/prompts/${result.data.id}`);
        }
      } else if (
        result.error.kind === "conflict" ||
        result.error.kind === "validation"
      ) {
        setError("name", { message: result.error.message });
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {mode === "create" ? (
          <Button size="sm">
            <Plus className="size-4" /> New set
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Pencil className="size-4" /> Edit
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New prompt set" : "Edit prompt set"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="set-name">Name</Label>
            <Input id="set-name" {...register("name")} autoFocus />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="set-description">Description (intent of the set)</Label>
            <Textarea id="set-description" rows={3} {...register("description")} />
            {errors.description && (
              <p className="text-sm text-destructive">
                {errors.description.message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : mode === "create" ? "Create" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
