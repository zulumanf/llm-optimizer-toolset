import { z } from "zod";

export const PROJECT_NAME_MAX = 80;
export const PROJECT_DESCRIPTION_MAX = 500;

const projectName = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .min(1, "Name is required.")
      .max(PROJECT_NAME_MAX, `Name must be at most ${PROJECT_NAME_MAX} characters.`)
  );

const projectDescription = z
  .string()
  .transform((s) => s.trim())
  .pipe(
    z
      .string()
      .max(
        PROJECT_DESCRIPTION_MAX,
        `Description must be at most ${PROJECT_DESCRIPTION_MAX} characters.`
      )
  )
  .optional();

export const createProjectSchema = z.object({
  name: projectName,
  description: projectDescription,
});

export const updateProjectSchema = z.object({
  id: z.string().uuid(),
  name: projectName.optional(),
  description: projectDescription,
});

export const projectIdSchema = z.object({
  id: z.string().uuid(),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
