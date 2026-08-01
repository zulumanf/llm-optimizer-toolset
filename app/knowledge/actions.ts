"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { sql } from "@/db/client";
import { enqueueJob } from "@/db/jobs";
import { getCurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import * as svc from "@/lib/claims/service";
import * as instructionsSvc from "@/lib/knowledge/instructions/service";
import { ingestSource } from "@/lib/knowledge/sources/ingest";

async function run<T>(
  fn: (user: Awaited<ReturnType<typeof getCurrentUser>>) => Promise<ActionResult<T>>
): Promise<ActionResult<T>> {
  try {
    const user = await getCurrentUser();
    const result = await fn(user);
    if (result.ok) revalidatePath("/projects", "layout");
    return result;
  } catch (err) {
    return fail(err);
  }
}

export async function proposeClaim(input: unknown) {
  return run((u) => svc.proposeClaim(u, input));
}
export async function approveClaim(input: unknown) {
  return run((u) => svc.approveClaim(u, input));
}
export async function rejectClaim(input: unknown) {
  return run((u) => svc.rejectClaim(u, input));
}
export async function setSubjectCompany(input: unknown) {
  return run((u) => svc.setSubjectCompany(u, input));
}
export async function setClaimDates(input: unknown) {
  return run((u) => svc.setClaimDates(u, input));
}
export async function resolveClaimContradiction(input: unknown) {
  return run((u) => svc.resolveClaimContradiction(u, input));
}

// ---------------------------------------------------- sources (D3)

/**
 * Upload a source document. Before D3 there was NO product path to add a
 * source — `ingestSource` was reachable only from the site crawler and a
 * script, so an operator could not hand the platform a PDF, a CSV export,
 * or a transcript. Extraction is enqueued automatically for an upload:
 * it is a single operator-initiated document, not a crawl fan-out.
 */
export async function uploadSource(
  formData: FormData
): Promise<ActionResult<{ sourceArtifactId: string; duplicate: boolean }>> {
  try {
    const user = await getCurrentUser();
    const file = formData.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return fail(new ClassifiedError("validation", "Choose a file to upload."));
    }
    const projectId = z.string().uuid().parse(formData.get("projectId"));
    const privacy = z
      .enum(["public", "client_only", "internal", "restricted"])
      .catch("client_only")
      .parse(formData.get("privacy") ?? "client_only");

    const result = await ingestSource(user, {
      projectId,
      origin: "upload",
      filename: file.name,
      declaredMimeType: file.type || undefined,
      bytes: Buffer.from(await file.arrayBuffer()),
      privacy,
    });
    if (!result.ok) return result;

    // Extract → proposed claims. A duplicate upload re-extracts nothing.
    if (!result.data.duplicate && result.data.extractionStatus !== "unsupported") {
      await enqueueJob(sql, "extract_claims", {
        sourceArtifactId: result.data.sourceArtifactId,
      });
    }
    revalidatePath(`/projects/${projectId}/knowledge/sources`);
    return ok({
      sourceArtifactId: result.data.sourceArtifactId,
      duplicate: result.data.duplicate,
    });
  } catch (err) {
    return fail(err);
  }
}

/** Queue claim extraction for an already-held source (e.g. a crawled page —
 * crawls deliberately do not auto-extract, so a fan-out cannot silently
 * spend tokens on every page). */
export async function requestClaimExtraction(
  input: unknown
): Promise<ActionResult<{ queued: boolean }>> {
  try {
    const user = await getCurrentUser();
    const parsed = z
      .object({ sourceArtifactId: z.string().uuid(), projectId: z.string().uuid() })
      .safeParse(input);
    if (!parsed.success) {
      return fail(new ClassifiedError("validation", "Invalid source id."));
    }
    void user; // authenticated staff (layout gate); artifact ownership checked below
    const [artifact] = await sql`
      select project_id from source_artifacts
      where id = ${parsed.data.sourceArtifactId}
    `;
    if (!artifact || (artifact.projectId as string) !== parsed.data.projectId) {
      return fail(new ClassifiedError("not_found", "Source not found for this client."));
    }
    await enqueueJob(sql, "extract_claims", {
      sourceArtifactId: parsed.data.sourceArtifactId,
    });
    revalidatePath(`/projects/${parsed.data.projectId}/knowledge/sources`);
    return ok({ queued: true });
  } catch (err) {
    return fail(err);
  }
}

// ------------------------------------------------ instructions (D3)

export async function createInstruction(input: unknown) {
  return run((u) => instructionsSvc.createInstruction(u, input));
}
export async function reviseInstruction(input: unknown) {
  return run((u) => instructionsSvc.reviseInstruction(u, input));
}
export async function approveInstructionVersion(input: unknown) {
  return run((u) => instructionsSvc.approveInstructionVersion(u, input));
}
