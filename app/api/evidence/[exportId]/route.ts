/**
 * Evidence-package download (evidence spec). Route handler by the same
 * pattern as the reports CSV export; authenticated via the standard session.
 */
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/db/client";
import { assertProjectAccess, getCurrentUser } from "@/lib/auth";
import { artifactPath } from "@/lib/evidence/storage";
import { recordArtifactAccessAsync } from "@/lib/security/access-log";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ exportId: string }> }
): Promise<NextResponse> {
  let user;
  try {
    user = await getCurrentUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { exportId } = await params;
  if (!z.string().uuid().safeParse(exportId).success) {
    return NextResponse.json({ error: "Invalid export id" }, { status: 400 });
  }
  const [row] = await sql`
    select e.storage_key, e.status, r.project_id
    from evidence_exports e
    join runs r on r.id = e.run_id
    where e.id = ${exportId}
  `;
  if (!row || row.status !== "completed" || !row.storageKey) {
    return NextResponse.json({ error: "Export not found" }, { status: 404 });
  }
  try {
    // 404, not 403: an export id resolving at all is client information.
    await assertProjectAccess(user, row.projectId as string);
  } catch {
    return NextResponse.json({ error: "Export not found" }, { status: 404 });
  }
  const bytes = await readFile(artifactPath(row.storageKey as string));

  // Taking a copy of a client's raw evidence off the platform is an access
  // event, not just a read (docs/10). Non-blocking: a download must not fail
  // because logging did, but an unlogged download is reported loudly.
  recordArtifactAccessAsync({
    userId: user.id,
    artifactType: "evidence_export",
    artifactId: exportId,
    projectId: (row.projectId as string | null) ?? null,
    action: "download",
    ipAddress: request.headers.get("x-forwarded-for"),
    userAgent: request.headers.get("user-agent"),
  });

  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="evidence-${exportId}.tar.gz"`,
    },
  });
}
