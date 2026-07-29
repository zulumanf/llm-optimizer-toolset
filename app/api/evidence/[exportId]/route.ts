/**
 * Evidence-package download (evidence spec). Route handler by the same
 * pattern as the reports CSV export; authenticated via the standard session.
 */
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "@/db/client";
import { getCurrentUser } from "@/lib/auth";
import { artifactPath } from "@/lib/evidence/storage";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ exportId: string }> }
): Promise<NextResponse> {
  try {
    await getCurrentUser();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { exportId } = await params;
  if (!z.string().uuid().safeParse(exportId).success) {
    return NextResponse.json({ error: "Invalid export id" }, { status: 400 });
  }
  const [row] = await sql`
    select storage_key, status from evidence_exports where id = ${exportId}
  `;
  if (!row || row.status !== "completed" || !row.storageKey) {
    return NextResponse.json({ error: "Export not found" }, { status: 404 });
  }
  const bytes = await readFile(artifactPath(row.storageKey as string));
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="evidence-${exportId}.tar.gz"`,
    },
  });
}
