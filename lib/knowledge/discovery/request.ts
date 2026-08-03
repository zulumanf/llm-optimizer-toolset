/**
 * The product entry point for external discovery (closing spec 027's
 * "not wired" gap). A human requests it; the crawl runs in the worker as
 * the system principal (B3: background work is the platform's act), and
 * the request itself is audited to the human who asked. One in-flight
 * discovery per project — a second click is a conflict, not a second
 * crawl of the same web.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { enqueueJob } from "@/db/jobs";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";

export const EXTERNAL_DISCOVERY_JOB = "external_discovery";

const requestSchema = z.object({ projectId: z.string().uuid() });

export async function requestExternalDiscovery(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ jobId: string }>> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid project id."));
  }
  const { projectId } = parsed.data;
  try {
    assertCanWrite(user);
    const jobId = await sql.begin(async (tx) => {
      const [project] = await tx`
        select status, subject_company_id from projects where id = ${projectId}
      `;
      if (!project) throw new ClassifiedError("not_found", "Project not found.");
      if (project.status !== "active") {
        throw new ClassifiedError("conflict", "Project is archived.");
      }
      // Refused at click time, not as a failed job an hour later: discovery
      // builds its queries from the subject's identity.
      if (!project.subjectCompanyId) {
        throw new ClassifiedError(
          "conflict",
          "Set a subject company first — discovery has nothing to search for without one."
        );
      }
      const [inFlight] = await tx`
        select id from jobs
        where type = ${EXTERNAL_DISCOVERY_JOB}
          and payload->>'projectId' = ${projectId}
          and status in ('queued', 'running')
        limit 1
      `;
      if (inFlight) {
        throw new ClassifiedError(
          "conflict",
          "A discovery run for this project is already queued or running."
        );
      }
      const id = await enqueueJob(tx, EXTERNAL_DISCOVERY_JOB, {
        projectId,
        requestedBy: user.id,
      });
      await writeAudit(tx, {
        userId: user.id,
        action: "discovery.requested",
        entity: "project",
        entityId: projectId,
        detail: { jobId: id },
      });
      return id;
    });
    return ok({ jobId });
  } catch (err) {
    return fail(err);
  }
}
