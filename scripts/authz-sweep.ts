/**
 * Spec 156 — page authorization sweep. Plants canary strings in a LOCAL
 * sandbox database, then fetches every page in app/ as the running server's
 * dev user and fails if any response body contains a canary it must not see.
 * The response body is what matters: a page can show a redirect or a 404
 * while its data is still streamed in the RSC payload.
 *
 * Run the server as a client against the same sandbox, ideally a production
 * build (the leak is not a dev-server artifact):
 *
 *   NEXT_DIST_DIR=.next-sweep DATABASE_URL=postgres://localhost:5433/<sandbox> AUTH_MODE=dev \
 *     ALLOW_DEV_AUTH_IN_PROD=1 npx next build
 *   NEXT_DIST_DIR=.next-sweep DATABASE_URL=... AUTH_MODE=dev DEV_USER_ROLE=client_viewer \
 *     ALLOW_DEV_AUTH_IN_PROD=1 npx next start -p 3157
 *   DATABASE_URL=... SWEEP_BASE_URL=http://localhost:3157 npx tsx --tsconfig tsconfig.json scripts/authz-sweep.ts
 *
 * Refuses unless DATABASE_URL is localhost and the database name contains
 * sandbox|test|e2e|audit. Never touches production; sends nothing.
 */
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const url = process.env.DATABASE_URL ?? "";
const parsed = (() => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
})();
if (!parsed || !["localhost", "127.0.0.1"].includes(parsed.hostname) || !/(sandbox|test|e2e|audit)/.test(parsed.pathname)) {
  console.error("Refusing: DATABASE_URL must be a LOCAL sandbox database (name containing sandbox|test|e2e|audit).");
  process.exit(1);
}
const BASE = process.env.SWEEP_BASE_URL ?? "http://localhost:3157";

const GRANTED = "5eed0156-0000-4000-8000-00000000a001";
const OTHER = "5eed0156-0000-4000-8000-00000000b002";
const RANDOM = "5eed0156-0000-4000-8000-00000000dead";
const CANARIES = {
  otherProject: "CANARY156OTHERPROJECT",
  otherTask: "CANARY156OTHERTASK",
  internalTask: "CANARY156INTERNALTASK",
  otherLearning: "CANARY156OTHERLEARNING",
};
/** Text the client MUST see on its own portal (the portal still works). */
const GRANTED_NAME = "Sweep granted client (synthetic)";

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === "page.tsx" ? [full] : [];
  });
}

function urlsFor(rel: string): { which: "granted" | "other" | "-"; path: string }[] {
  const segs = rel.split("/").slice(1, -1).filter((s) => !(s.startsWith("(") && s.endsWith(")")));
  const isProject = (s: string) => s === "[id]" || s === "[projectId]";
  const targets: ("granted" | "other" | "-")[] = segs.some(isProject) ? ["granted", "other"] : ["-"];
  return targets.map((which) => ({
    which,
    path: "/" + segs.map((s) => (isProject(s) ? (which === "granted" ? GRANTED : OTHER) : s.startsWith("[") ? RANDOM : s)).join("/"),
  }));
}

async function main() {
  const { sql } = await import("@/db/client");
  const { DEV_USER_ID } = await import("@/lib/auth");
  await sql`insert into users (id, email, name, role) values (${DEV_USER_ID}, 'dev@avos.local', 'Dev', 'client_viewer') on conflict (id) do nothing`;
  await sql`
    insert into projects (id, name, description) values
      (${GRANTED}, ${GRANTED_NAME}, 'granted'),
      (${OTHER}, ${CANARIES.otherProject}, ${CANARIES.otherProject})
    on conflict (id) do nothing`;
  await sql`insert into user_project_access (user_id, project_id) values (${DEV_USER_ID}, ${GRANTED}) on conflict do nothing`;
  await sql`delete from user_project_access where user_id = ${DEV_USER_ID} and project_id = ${OTHER}`;
  for (const [projectId, title] of [[GRANTED, CANARIES.internalTask], [OTHER, CANARIES.otherTask]] as const) {
    const [hit] = await sql`select 1 from tasks where project_id = ${projectId} and title = ${title}`;
    if (!hit) await sql`insert into tasks (project_id, title, evidence_ids, status, client_visible) values (${projectId}, ${title}, '{}', 'approved', false)`;
  }

  const [learning] = await sql`select 1 from learnings where statement = ${CANARIES.otherLearning}`;
  if (!learning) {
    await sql`insert into learnings (project_id, category, statement, confidence_label, created_by) values (${OTHER}, 'content', ${CANARIES.otherLearning}, 'probable', ${DEV_USER_ID})`;
  }

  const root = join(__dirname, "..");
  const rels = pages(join(root, "app")).map((f) => relative(root, f).split(sep).join("/")).sort();
  let leaks = 0;
  let brokenPortal = 0;
  let total = 0;
  for (const rel of rels) {
    for (const { which, path } of urlsFor(rel)) {
      total += 1;
      let body = "";
      let status = 0;
      try {
        const res = await fetch(BASE + path, { redirect: "manual" });
        status = res.status;
        body = await res.text();
      } catch (err) {
        console.log(`ERROR ${path}: ${(err as Error).message}`);
        leaks += 1;
        continue;
      }
      const hits = Object.values(CANARIES).filter((c) => body.includes(c));
      if (hits.length > 0) leaks += 1;
      // The client's own portal must still render its own program.
      // Pages addressed by a random sub-id (an answer that does not exist)
      // must 404, and a redirect within the client's own portal is healthy.
      const ownPortal = which === "granted" && path.startsWith("/portal/") && !path.includes(RANDOM);
      const ownRedirect = new RegExp(`NEXT_REDIRECT;[a-z]+;/portal/${GRANTED}[;"]`).test(body);
      const portalBroken = ownPortal && !ownRedirect && (!body.includes(GRANTED_NAME) || body.includes("NEXT_HTTP_ERROR_FALLBACK;404"));
      if (portalBroken) brokenPortal += 1;
      console.log(`${hits.length > 0 ? "LEAK" : portalBroken ? "BROKEN" : "ok  "} ${status} ${which.padEnd(7)} ${path}${hits.length > 0 ? ` ${hits.join(",")}` : ""}`);
    }
  }
  console.log(`\n${total} requests, ${leaks} leaking, ${brokenPortal} own-portal pages broken`);
  await sql.end();
  process.exit(leaks > 0 || brokenPortal > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
