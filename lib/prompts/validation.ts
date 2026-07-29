import { z } from "zod";
import {
  PROMPT_CATEGORIES,
  PROMPT_TEXT_MAX,
  SET_NAME_MAX,
  SET_DESCRIPTION_MAX,
} from "@/lib/constants";

const setName = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, "Name is required.")
      .max(SET_NAME_MAX, `Name must be at most ${SET_NAME_MAX} characters.`)
  );

const setDescription = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .max(
        SET_DESCRIPTION_MAX,
        `Description must be at most ${SET_DESCRIPTION_MAX} characters.`
      )
  )
  .optional();

const promptText = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, "Prompt text is required.")
      .max(PROMPT_TEXT_MAX, `Prompt must be at most ${PROMPT_TEXT_MAX} characters.`)
  );

const category = z.enum(PROMPT_CATEGORIES);
const language = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .pipe(z.string().min(2).max(8));

export const createSetSchema = z.object({
  projectId: z.string().uuid(),
  name: setName,
  description: setDescription,
});

export const updateSetSchema = z.object({
  id: z.string().uuid(),
  name: setName.optional(),
  description: setDescription,
});

export const setIdSchema = z.object({ id: z.string().uuid() });

export const addPromptSchema = z.object({
  setId: z.string().uuid(),
  text: promptText,
  category,
  language: language.optional(),
  isHoldout: z.boolean().optional(),
});

export const updatePromptSchema = z.object({
  promptId: z.string().uuid(),
  text: promptText.optional(),
  category: category.optional(),
  language: language.optional(),
});

export const promptIdSchema = z.object({ promptId: z.string().uuid() });

export const reorderSchema = z.object({
  setId: z.string().uuid(),
  orderedPromptIds: z.array(z.string().uuid()).min(1),
});

export const duplicateSetSchema = z
  .object({
    setId: z.string().uuid().optional(),
    versionId: z.string().uuid().optional(),
    newName: setName,
  })
  .refine((v) => (v.setId ? !v.versionId : !!v.versionId), {
    message: "Provide exactly one of setId or versionId.",
  });
