/**
 * Spec 156 / P1-13 — structural guard for server actions (no database).
 *
 * Server actions are public POST endpoints: no layout or page gate protects
 * them. Every exported function of every `"use server"` module must either
 *   - call a staff gate (assertCanWrite / assertRole) BEFORE parsing input,
 *     querying, or awaiting anything but getCurrentUser(), or
 *   - delegate to a runner in the same file that does (makeActionRunner, or
 *     a local helper whose own body gates first).
 * The runtime proof is tests/integration/server-action-authorization.test.ts;
 * this test fails fast, in review, when a new ungated action is written.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTION_ALLOW_LIST, ACTION_EXCLUDED_DIRS, CLIENT_ACTIONS } from "../helpers/authz-exemptions";

const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "app");

/** Shared with the runtime suite: one list, every entry with its reason. */
const EXCLUDED_DIRS = Object.keys(ACTION_EXCLUDED_DIRS);
const ALLOW_LIST = new Set(Object.keys(ACTION_ALLOW_LIST));

/** An UNCONDITIONAL gate statement: `if (x) assertRole(...)` does not count. */
const GATE = /^\s*(?:assertCanWrite|assertRole)\(/m;
/** Anything that touches data or input before a gate is a violation. */
const BEFORE_GATE = /sql`|\bsql\.|\btx`|safeParse\(|\.parse\(|\bawait (?!getCurrentUser\(\))/;

function serverActionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return serverActionFiles(full);
    return /\.tsx?$/.test(e.name) && /^["']use server["']/.test(readFileSync(full, "utf8").trimStart()) ? [full] : [];
  });
}

/** Source of a top-level function from its declaration to the next top-level declaration. */
function functionBodies(src: string): Map<string, { exported: boolean; body: string }> {
  const out = new Map<string, { exported: boolean; body: string }>();
  const decl = /^(export )?(?:async )?function (\w+)|^(export )?const (\w+)\s*=\s*(?:async\s*)?(?:<[^>]*>)?\(/gm;
  const marks = [...src.matchAll(decl)].map((m) => ({ index: m.index!, exported: Boolean(m[1] || m[3]), name: (m[2] ?? m[4])! }));
  marks.forEach((m, i) => {
    const end = i + 1 < marks.length ? marks[i + 1]!.index : src.length;
    out.set(m.name, { exported: m.exported, body: src.slice(m.index, end) });
  });
  return out;
}

/** Does the body gate before it touches anything? Signature lines are skipped. */
function gatesFirst(body: string): boolean {
  const open = body.indexOf("{", body.indexOf(")"));
  const inner = body.slice(open + 1);
  const gate = inner.search(GATE);
  if (gate === -1) return false;
  const touch = inner.search(BEFORE_GATE);
  return touch === -1 || gate < touch;
}

function violations(rel: string, src: string): string[] {
  const fns = functionBodies(src);
  const runners = new Set<string>([...src.matchAll(/const (\w+)\s*=\s*makeActionRunner\(/g)].map((m) => m[1]!));
  for (const [name, f] of fns) if (!f.exported && gatesFirst(f.body)) runners.add(name);
  // A local wrapper that only delegates to a gating runner gates too
  // (followed transitively, e.g. `const run = (id, fn) => runner(fn)`).
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, f] of fns) {
      if (f.exported || runners.has(name)) continue;
      if ([...runners].some((r) => new RegExp(`=>\\s*${r}\\(|\\breturn ${r}\\(`).test(f.body))) {
        runners.add(name);
        grew = true;
      }
    }
  }
  const out: string[] = [];
  for (const [name, f] of fns) {
    if (!f.exported || ALLOW_LIST.has(`${rel}:${name}`)) continue;
    if (`${rel}:${name}` in CLIENT_ACTIONS) {
      // Client-callable: must go through the portal wrapper, which hands the
      // call to a service that asserts the client approver gate (runtime suite).
      if (!/\breturn respond\(/.test(f.body)) out.push(`${rel}:${name} (client action not through respond())`);
      continue;
    }
    const viaRunner = [...runners].some((r) => new RegExp(`\\breturn ${r}(?:<[^>]*>)?\\(`).test(f.body) || new RegExp(`=>\\s*${r}\\(`).test(f.body));
    if (!viaRunner && !gatesFirst(f.body)) out.push(`${rel}:${name}`);
  }
  return out;
}

const portalSource = () => readFileSync(join(ROOT, "app/portal/[projectId]/actions.ts"), "utf8");

const files = serverActionFiles(APP)
  .map((f) => relative(ROOT, f).split(sep).join("/"))
  .filter((rel) => !EXCLUDED_DIRS.some((d) => rel.startsWith(d)));

describe("server actions gate before they touch anything (structural)", () => {
  it("the shared runner itself refuses non-staff before running the action", () => {
    const runner = readFileSync(join(ROOT, "lib/actions/run.ts"), "utf8");
    const gate = runner.search(/^\s*assertCanWrite\(user\);/m);
    const call = runner.indexOf("await fn(user)");
    expect(gate).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(gate);
  });

  it("finds the action modules", () => {
    expect(files.length).toBeGreaterThanOrEqual(25);
  });

  it("every client action is declared with an audience and reason, and exists", () => {
    for (const [key, { audience, reason }] of Object.entries(CLIENT_ACTIONS)) {
      expect(audience, key).toBe("CLIENT_VALIDATOR");
      expect(reason.trim().length, key).toBeGreaterThan(20);
      const [file, name] = key.split(":");
      expect(new RegExp(`export (?:async )?function ${name}\\b`).test(readFileSync(join(ROOT, file!), "utf8")), key).toBe(true);
    }
    // The portal wrapper checks the client approver BEFORE running the action.
    const wrapper = portalSource().slice(portalSource().indexOf("async function respond"));
    const gate = wrapper.search(/^\s*await assertClientApprover\(user, projectId\);/m);
    const run = wrapper.indexOf("await fn(user)");
    expect(gate, "respond() must call assertClientApprover").toBeGreaterThan(-1);
    expect(run, "respond() must run the action only after the gate").toBeGreaterThan(gate);
    // And nothing client-callable hides outside the list.
    const portal = readFileSync(join(ROOT, "app/portal/[projectId]/actions.ts"), "utf8");
    const exported = [...portal.matchAll(/export async function (\w+)/g)].map((m) => `app/portal/[projectId]/actions.ts:${m[1]}`);
    expect(exported.filter((k) => !(k in CLIENT_ACTIONS))).toEqual([]);
  });

  it("every exemption states a reason and still exists", () => {
    for (const [key, reason] of [...Object.entries(ACTION_ALLOW_LIST), ...Object.entries(ACTION_EXCLUDED_DIRS)]) {
      expect(reason.trim().length, key).toBeGreaterThan(20);
    }
    for (const key of Object.keys(ACTION_ALLOW_LIST)) {
      const [file, name] = key.split(":");
      const src = readFileSync(join(ROOT, file!), "utf8");
      expect(new RegExp(`export (?:async )?function ${name}\\b`).test(src), key).toBe(true);
    }
  });

  it("every exported action gates first or delegates to a gating runner", () => {
    const offenders = files.flatMap((rel) => violations(rel, readFileSync(join(ROOT, rel), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("the checker rejects an ungated action and one that parses before gating", () => {
    const ungated = `"use server";
export async function a(input: unknown) {
  const user = await getCurrentUser();
  return await svc.doIt(user, input);
}`;
    const late = `"use server";
export async function b(raw: unknown) {
  const parsed = schema.safeParse(raw);
  const user = await getCurrentUser();
  assertCanWrite(user);
}`;
    const good = `"use server";
const run = makeActionRunner("/x");
export async function c(input: unknown) {
  return run((u) => svc.c(u, input));
}
export async function d(raw: unknown) {
  try {
    const user = await getCurrentUser();
    assertCanWrite(user);
    const parsed = schema.safeParse(raw);
  } catch {}
}`;
    const conditional = `"use server";
export async function e(input: { mode: string }) {
  const user = await getCurrentUser();
  if (input.mode === "live") assertRole(user, "admin");
  await svc.start(user, input);
}`;
    expect(violations("x.ts", conditional)).toEqual(["x.ts:e"]);
    expect(violations("x.ts", ungated)).toEqual(["x.ts:a"]);
    expect(violations("x.ts", late)).toEqual(["x.ts:b"]);
    expect(violations("x.ts", good)).toEqual([]);
  });
});
