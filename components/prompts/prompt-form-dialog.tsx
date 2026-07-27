"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useForm, Controller } from "react-hook-form";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addPrompt, updatePrompt } from "@/app/prompts/actions";
import { PROMPT_CATEGORIES, PROMPT_TEXT_MAX } from "@/lib/constants";

const formSchema = z.object({
  text: z.string().trim().min(1, "Prompt text is required.").max(PROMPT_TEXT_MAX),
  category: z.enum(PROMPT_CATEGORIES),
});

type FormValues = z.infer<typeof formSchema>;

interface Props {
  mode: "add" | "edit";
  setId?: string;
  prompt?: { id: string; text: string; category: FormValues["category"] };
  /** Texts of the set's other active prompts, for the duplicate warning. */
  existingTexts?: string[];
}

export function PromptFormDialog({ mode, setId, prompt, existingTexts }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    values: {
      text: prompt?.text ?? "",
      category: prompt?.category ?? "recommendation",
    },
  });

  const onSubmit = (values: FormValues) => {
    startTransition(async () => {
      const result =
        mode === "add"
          ? await addPrompt({ setId, ...values })
          : await updatePrompt({ promptId: prompt?.id, ...values });
      if (result.ok) {
        toast.success(mode === "add" ? "Prompt added." : "Prompt updated.");
        setOpen(false);
        reset();
        router.refresh();
      } else if (
        result.error.kind === "validation" ||
        result.error.kind === "conflict"
      ) {
        setError("text", { message: result.error.message });
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {mode === "add" ? (
          <Button size="sm" variant="outline">
            <Plus className="size-4" /> Add prompt
          </Button>
        ) : (
          <Button size="icon-sm" variant="ghost" aria-label="Edit prompt">
            <Pencil className="size-4" />
          </Button>
        )}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "add" ? "Add prompt" : "Edit prompt"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="prompt-text">
              Prompt (as a real user would phrase it)
            </Label>
            <Textarea
              id="prompt-text"
              rows={3}
              className="font-mono"
              {...register("text")}
              autoFocus
            />
            {errors.text && (
              <p className="text-sm text-destructive">{errors.text.message}</p>
            )}
            {/* Near-duplicates are legitimate, so this warns without blocking */}
            {existingTexts?.some(
              (t) => t.trim().toLowerCase() === watch("text").trim().toLowerCase()
            ) && (
              <p className="text-sm text-warning">
                An identical prompt already exists in this set.
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Controller
              control={control}
              name="category"
              render={({ field }) => (
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger className="w-48">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROMPT_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
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
              {pending ? "Saving…" : mode === "add" ? "Add" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
