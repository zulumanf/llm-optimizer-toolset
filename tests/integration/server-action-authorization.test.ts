/**
 * Spec 156 / P1-13 — WRITE security: no client account can invoke a staff
 * server action.
 *
 * Every exported function of every `"use server"` module under app/ is
 * called as `client_viewer` and as `client_validator`. The client is GRANTED
 * a real project and every call names that project, so an action guarded
 * only by project access (not by a staff role) is caught. A call passes only
 * if ALL of these hold:
 *
 *   1. it is refused (forbidden/not_found result, or a thrown refusal);
 *   2. the refusal came from a STAFF gate (assertCanWrite / assertRole), not
 *      from a validation error or a lookup that happened to miss;
 *   3. no database query ran before that gate (auth-internal grant reads
 *      excepted) — authorization precedes data access;
 *   4. no INSERT/UPDATE/DELETE statement ran on any table, including
 *      statements later rolled back and statements matching zero rows
 *      (statement-level triggers bump a sequence, which never rolls back);
 *   5. no outbound network call (fetch, http/https) and no subprocess.
 *
 * A new action file is covered the moment it exists; an action is exempt
 * only by being on ALLOW_LIST with a reason. Positive controls prove the
 * instruments detect queries, writes and success for staff.
 */
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { join, relative, sep } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser, Role } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { ACTION_ALLOW_LIST, ACTION_EXCLUDED_DIRS, CLIENT_ACTIONS } from "../helpers/authz-exemptions";
import { truncateAll } from "../helpers/db";

const probe = vi.hoisted(() => ({
  actor: null as CurrentUser | null,
  queries: 0,
  authDepth: 0,
  staffDenials: [] as string[],
  clientGateDenials: [] as string[],
  queriesAtFirstDenial: null as number | null,
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  const current = () => {
    if (!probe.actor) throw new Error("test actor not set");
    return probe.actor;
  };
  const staffGate =
    <A extends unknown[]>(name: string, fn: (...a: A) => void) =>
    (...a: A) => {
      try {
        fn(...a);
      } catch (err) {
        probe.staffDenials.push(name);
        probe.queriesAtFirstDenial ??= probe.queries;
        throw err;
      }
    };
  const authRead =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
    async (...a: A) => {
      probe.authDepth += 1;
      try {
        return await fn(...a);
      } finally {
        probe.authDepth -= 1;
      }
    };
  return {
    ...actual,
    getCurrentUser: async () => current(),
    getCurrentUserOrNull: async () => current(),
    assertCanWrite: staffGate("assertCanWrite", actual.assertCanWrite),
    assertRole: staffGate("assertRole", actual.assertRole),
    assertProjectAccess: authRead(actual.assertProjectAccess),
    assertClientApprover: async (...a: Parameters<typeof actual.assertClientApprover>) => {
      probe.authDepth += 1;
      try {
        await actual.assertClientApprover(...a);
      } catch (err) {
        probe.clientGateDenials.push("assertClientApprover");
        probe.queriesAtFirstDenial ??= probe.queries;
        throw err;
      } finally {
        probe.authDepth -= 1;
      }
    },
    visibleProjectIds: authRead(actual.visibleProjectIds),
  };
});

// Count every query the application issues (not the test's own connection).
vi.mock("@/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db/client")>();
  const count = () => {
    if (probe.authDepth === 0) probe.queries += 1;
  };
  const target = actual.sql;
  const wrapped = new Proxy(target, {
    apply(t, thisArg, args) {
      count();
      return Reflect.apply(t, thisArg, args);
    },
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "begin" || prop === "unsafe" || prop === "reserve" || prop === "file") {
        return (...a: unknown[]) => {
          count();
          return (value as (...x: unknown[]) => unknown).apply(t, a);
        };
      }
      return (value as (...x: unknown[]) => unknown).bind(t);
    },
  });
  return { ...actual, sql: wrapped };
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  revalidatePath: () => undefined,
  revalidateTag: () => undefined,
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
}));

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "app");

/** Shared with the structural suite: one list, every entry with its reason. */
const EXCLUDED_DIRS = Object.keys(ACTION_EXCLUDED_DIRS).map((d) => join(ROOT, d.replace(/\/$/, "")));
const ALLOW_LIST = ACTION_ALLOW_LIST;

const REFUSAL_KINDS = ["forbidden", "not_found"];
const CLIENT_ID = "00000000-0000-4000-8000-00000000a002";
const GRANTED = "5eed0156-0000-4000-8000-0000000a0001";
const UNGRANTED = "5eed0156-0000-4000-8000-0000000b0002";

function serverActionFiles(dir: string): string[] {
  if (EXCLUDED_DIRS.includes(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...serverActionFiles(full));
    else if (/\.tsx?$/.test(entry.name) && /^["']use server["']/.test(readFileSync(full, "utf8").trimStart())) out.push(full);
  }
  return out;
}

/** Arguments naming the client's OWN granted project wherever an id fits. */
function argsFor(fn: (...args: unknown[]) => unknown): unknown[] {
  const input = { projectId: GRANTED, id: GRANTED };
  if (fn.length === 0) return [];
  if (fn.length === 1) return [input];
  return [GRANTED, input, ...Array.from({ length: fn.length - 2 }, () => input)];
}

interface Outcome {
  refused: boolean;
  detail: string;
}

async function invoke(fn: (...args: unknown[]) => unknown): Promise<Outcome> {
  try {
    const result = (await fn(...argsFor(fn))) as { ok?: boolean; error?: { kind?: string; message?: string } } | undefined;
    const refused = Boolean(result && result.ok === false && REFUSAL_KINDS.includes(result.error?.kind ?? ""));
    return { refused, detail: `returned ${JSON.stringify(result)?.slice(0, 160)}` };
  } catch (err) {
    const kind = (err as { kind?: string }).kind ?? "";
    return { refused: REFUSAL_KINDS.includes(kind), detail: `threw ${String(err).slice(0, 160)}` };
  }
}

describe.skipIf(!TEST_URL)("server-action authorization: clients cannot invoke staff actions", () => {
  let raw: postgres.Sql;
  const external: string[] = [];
  const files = serverActionFiles(APP);
  const mutationCount = async () => Number((await raw`select last_value + (case when is_called then 1 else 0 end) as n from authz_mutation_seq`)[0]!.n);

  beforeAll(async () => {
    raw = postgres(TEST_URL!, { onnotice: () => {}, max: 2 });
    await truncateAll(raw as never);
    await seedTestActors(raw as never);
    await raw`insert into projects (id, name) values (${GRANTED}, 'Granted client (synthetic)') on conflict (id) do nothing`;
    await raw`insert into user_project_access (user_id, project_id) values (${CLIENT_ID}, ${GRANTED}) on conflict do nothing`;
    await raw`insert into projects (id, name) values (${UNGRANTED}, 'Other client (synthetic)') on conflict (id) do nothing`;
    // Statement-level probes: fire once per write statement, even when it
    // matches no row or its transaction rolls back (sequences never roll back).
    await raw.unsafe(`
      create sequence if not exists authz_mutation_seq;
      create or replace function authz_mutation_probe() returns trigger language plpgsql as $$
      begin perform nextval('authz_mutation_seq'); return null; end $$;
    `);
    const tables = await raw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    for (const t of tables) {
      await raw.unsafe(`drop trigger if exists authz_probe on "${t.tablename}"; create trigger authz_probe after insert or update or delete on "${t.tablename}" for each statement execute function authz_mutation_probe();`);
    }
    vi.stubGlobal("fetch", async (input: unknown) => {
      external.push(`fetch ${String(input).slice(0, 120)}`);
      throw new Error("network disabled in authorization test");
    });
    for (const [mod, name] of [[http, "http"], [https, "https"]] as const) {
      for (const m of ["request", "get"] as const) {
        vi.spyOn(mod, m).mockImplementation(((...a: unknown[]) => {
          external.push(`${name}.${m} ${String(a[0]).slice(0, 120)}`);
          throw new Error("network disabled in authorization test");
        }) as never);
      }
    }
    for (const m of ["spawn", "exec", "execFile", "fork"] as const) {
      vi.spyOn(childProcess, m).mockImplementation(((cmd: unknown) => {
        external.push(`child_process.${m} ${String(cmd).slice(0, 80)}`);
        throw new Error("subprocesses disabled in authorization test");
      }) as never);
    }
    // Import every module up front so import-time work is not measured.
    for (const f of files) await import(f);
  }, 120_000);

  afterAll(async () => {
    const tables = await raw<{ tablename: string }[]>`select tablename from pg_tables where schemaname = 'public'`;
    for (const t of tables) await raw.unsafe(`drop trigger if exists authz_probe on "${t.tablename}"`);
    await raw.unsafe(`drop function if exists authz_mutation_probe() cascade; drop sequence if exists authz_mutation_seq;`);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await raw.end();
    const { sql } = await import("@/db/client");
    await sql.end();
  });

  async function measured(fn: (...args: unknown[]) => unknown) {
    probe.queries = 0;
    probe.staffDenials = [];
    probe.clientGateDenials = [];
    probe.queriesAtFirstDenial = null;
    external.length = 0;
    const before = await mutationCount();
    const outcome = await invoke(fn);
    // Let fire-and-forget work settle so it is attributed to this call.
    await new Promise((r) => setTimeout(r, 25));
    const writes = (await mutationCount()) - before;
    return { outcome, writes, queriesBeforeGate: probe.queriesAtFirstDenial, staffDenials: [...probe.staffDenials], clientGateDenials: [...probe.clientGateDenials], external: [...external], queries: probe.queries };
  }

  it("finds the action modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it("every allow-listed action still exists", async () => {
    for (const key of Object.keys(ALLOW_LIST)) {
      const [file, name] = key.split(":");
      const mod = (await import(join(ROOT, file!))) as Record<string, unknown>;
      expect(typeof mod[name!], key).toBe("function");
    }
  });

  it("positive control (staff): the instruments see queries, writes and success", async () => {
    probe.actor = { id: "00000000-0000-4000-8000-000000000401", email: "op@test.local", name: "Operator", role: "operator" };
    await raw`update users set role = 'operator' where id = ${probe.actor.id}`;
    const projects = (await import("@/app/projects/actions")) as unknown as Record<string, (i: unknown) => Promise<{ ok: boolean }>>;
    const created = await measured(() => projects.createProject!({ name: `Authz control ${randomUUID().slice(0, 8)}` }));
    expect(created.outcome.detail).toMatch(/"ok":true/);
    expect(created.writes).toBeGreaterThan(0);
    expect(created.queries).toBeGreaterThan(0);
    expect(created.staffDenials).toEqual([]);
    const automation = (await import("@/app/automation/actions")) as unknown as Record<string, (i: unknown) => Promise<{ ok: boolean }>>;
    const suppressed = await measured(() => automation.suppressContact!({ value: "control@example.test", scope: "email", reason: "manual", detail: "authorization test control" }));
    expect(suppressed.outcome.detail).toMatch(/"ok":true/);
    expect(suppressed.writes).toBeGreaterThan(0);
    const assistant = (await import("@/app/assistant/actions")) as unknown as Record<string, () => Promise<{ ok: boolean }>>;
    expect((await measured(() => assistant.listAssistantConversations!())).outcome.detail).toMatch(/"ok":true/);
  });

  for (const role of ["client_viewer", "client_validator"] as Role[]) {
    it(`refuses ${role} on every staff action — gate first, no query, no write, no side effect`, async () => {
      await raw`update users set role = ${role} where id = ${CLIENT_ID}`;
      probe.actor = { id: CLIENT_ID, email: "client@example.test", name: "Client", role };
      const failures: string[] = [];
      let checked = 0;
      for (const file of files) {
        const rel = relative(ROOT, file).split(sep).join("/");
        const mod = (await import(file)) as Record<string, unknown>;
        for (const [name, value] of Object.entries(mod)) {
          if (typeof value !== "function") continue;
          const key = `${rel}:${name}`;
          if (key in ALLOW_LIST || key in CLIENT_ACTIONS) continue;
          checked += 1;
          const m = await measured(value as (...args: unknown[]) => unknown);
          const problems: string[] = [];
          if (!m.outcome.refused) problems.push(`not refused (${m.outcome.detail})`);
          if (m.staffDenials.length === 0) problems.push("no staff gate refused it");
          if (m.queriesBeforeGate !== null && m.queriesBeforeGate > 0) problems.push(`${m.queriesBeforeGate} query(ies) before the gate`);
          if (m.writes > 0) problems.push(`${m.writes} write statement(s)`);
          if (m.external.length > 0) problems.push(`side effect: ${m.external.join("; ")}`);
          if (problems.length > 0) failures.push(`${key} — ${problems.join(" | ")}`);
        }
      }
      // AUTHZ_REPORT_FILE=<path> writes the full list (vitest truncates diffs).
      if (process.env.AUTHZ_REPORT_FILE) appendFileSync(process.env.AUTHZ_REPORT_FILE, `## ${role}: ${failures.length} of ${checked}\n${failures.join("\n")}\n`);
      expect(checked).toBeGreaterThan(200);
      expect(failures).toEqual([]);
    }, 300_000);
  }
  /** Client actions take the project id first; pad the rest with inputs. */
  const clientArgs = (fn: (...args: unknown[]) => unknown, projectId: string): unknown[] =>
    [projectId, ...Array.from({ length: Math.max(0, fn.length - 1) }, () => ({ projectId, id: projectId }))];

  it("client actions (spec 155 R1/R2): refused for viewers, other projects and staff — gate first, no write, no side effect", async () => {
    const callers: { label: string; role: Role; id: string; projectId: string; expect: "client_gate" | "not_found" }[] = [
      { label: "client_viewer on its own project", role: "client_viewer", id: CLIENT_ID, projectId: GRANTED, expect: "client_gate" },
      { label: "client_validator on an ungranted project", role: "client_validator", id: CLIENT_ID, projectId: UNGRANTED, expect: "not_found" },
      { label: "staff (operator)", role: "operator", id: "00000000-0000-4000-8000-000000000401", projectId: GRANTED, expect: "client_gate" },
    ];
    const failures: string[] = [];
    let checked = 0;
    for (const c of callers) {
      await raw`update users set role = ${c.role} where id = ${c.id}`;
      probe.actor = { id: c.id, email: "caller@example.test", name: "Caller", role: c.role };
      for (const key of Object.keys(CLIENT_ACTIONS)) {
        const [file, name] = key.split(":");
        const mod = (await import(join(ROOT, file!))) as Record<string, (...args: unknown[]) => unknown>;
        const fn = mod[name!]!;
        const m = await measured(() => fn(...clientArgs(fn, c.projectId)));
        checked += 1;
        const problems: string[] = [];
        if (!m.outcome.refused) problems.push(`not refused (${m.outcome.detail})`);
        if (c.expect === "client_gate" && m.clientGateDenials.length === 0) problems.push("the client approver gate did not refuse it");
        if (c.expect === "not_found" && !/not_found|Project not found/.test(m.outcome.detail)) problems.push(`expected not_found (${m.outcome.detail})`);
        if (m.queriesBeforeGate !== null && m.queriesBeforeGate > 0) problems.push(`${m.queriesBeforeGate} query(ies) before the gate`);
        if (m.writes > 0) problems.push(`${m.writes} write statement(s)`);
        if (m.external.length > 0) problems.push(`side effect: ${m.external.join("; ")}`);
        if (problems.length > 0) failures.push(`${c.label} → ${key} — ${problems.join(" | ")}`);
      }
    }
    await raw`update users set role = 'client_viewer' where id = ${CLIENT_ID}`;
    expect(checked).toBe(Object.keys(CLIENT_ACTIONS).length * callers.length);
    expect(failures).toEqual([]);
  }, 300_000);
});
