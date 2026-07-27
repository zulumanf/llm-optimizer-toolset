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
import { createProject, updateProject } from "@/app/projects/actions";
import {
  PROJECT_NAME_MAX,
  PROJECT_DESCRIPTION_MAX,
} from "@/lib/projects/validation";

// Client-side mirror of the server schema (server remains the authority)
const formSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(PROJECT_NAME_MAX),
  description: z.string().trim().max(PROJECT_DESCRIPTION_MAX).optional(),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
  mode: "create" | "edit";
  project?: { id: string; name: string; description: string | null };
}

export function ProjectFormDialog({ mode, project }: Props) {
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
    values: {
      name: project?.name ?? "",
      description: project?.description ?? "",
    },
  });

  const onSubmit = (values: FormValues) => {
    startTransition(async () => {
      const result =
        mode === "create"
          ? await createProject(values)
          : await updateProject({ id: project?.id, ...values });
      if (result.ok) {
        toast.success(mode === "create" ? "Project created." : "Project updated.");
        setOpen(false);
        reset();
        if (mode === "create") router.push(`/projects/${result.data.id}`);
      } else if (result.error.kind === "conflict" || result.error.kind === "validation") {
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
            <Plus className="size-4" /> New
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
            {mode === "create" ? "New project" : "Edit project"}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input id="project-name" {...register("name")} autoFocus />
            {errors.name && (
              <p className="text-sm text-destructive">{errors.name.message}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="project-description">Description</Label>
            <Textarea id="project-description" rows={3} {...register("description")} />
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
