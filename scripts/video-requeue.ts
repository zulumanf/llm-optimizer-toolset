/** Spec 138: founder requeue of a review_required video after fixing the cause.
 *   npx tsx scripts/video-requeue.ts <artifactId> "<reason>" [--as <email>] */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
async function main(): Promise<void> {
  const [id, reason] = [process.argv[2], process.argv[3]];
  if (!id || !reason) throw new Error("usage: <artifactId> <reason> [--as <email>]");
  const i = process.argv.indexOf("--as");
  const [u] = i >= 0 ? await sql`select id, email, name, role from users where email = ${process.argv[i + 1]!}` : await sql`select id, email, name, role from users where role = 'admin' order by created_at limit 1`;
  if (!u) throw new Error("no user");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const { requeueVideoWalkthrough, getVideoArtifact } = await import("@/lib/prospects/video-walkthrough");
  await requeueVideoWalkthrough(user, id, reason);
  console.log(JSON.stringify({ id, stage: (await getVideoArtifact(id))?.stage }));
  await sql.end();
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
