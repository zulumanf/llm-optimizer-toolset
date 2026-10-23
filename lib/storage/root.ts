/**
 * The artifact root (spec 151 D2). Evidence files, knowledge sources and
 * video assets live under one directory: ARTIFACT_ROOT when set (a mounted
 * persistent volume in production), else ./var for local development.
 *
 * On a platform where web and worker are separate containers, the root must
 * be storage BOTH can see — a volume attached to one service is not enough.
 * Until object storage replaces this, docs/engineering/production-readiness.md
 * names that as a release blocker.
 */
import { join } from "node:path";

export function artifactRoot(): string {
  const configured = process.env.ARTIFACT_ROOT?.trim();
  return configured && configured.length > 0 ? configured : join(process.cwd(), "var");
}
