/**
 * Test actors (spec 014).
 *
 * Integration tests construct `CurrentUser` literals directly instead of going
 * through `getCurrentUser()`, which is a reasonable shortcut — but it means
 * they invent identities that the application would never mint. Once
 * `audit_log.user_id` became a real foreign key, that shortcut started failing
 * honestly rather than silently.
 *
 * Rather than weaken the constraint, tests seed the identities they act as.
 * Every fixture id lives in one reserved namespace (`00000000-0000-4000-8000-…`)
 * so this helper can provision the whole range once per file, idempotently,
 * without each test having to remember.
 */
import type { Sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";

/** Every actor id referenced anywhere in the suite. */
export const TEST_ACTOR_IDS = [
  "00000000-0000-4000-8000-000000000000",
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-0000000000aa",
  "00000000-0000-4000-8000-0000000000bb",
  "00000000-0000-4000-8000-0000000000cc",
  "00000000-0000-4000-8000-0000000000dd",
  "00000000-0000-4000-8000-0000000000ee",
  "00000000-0000-4000-8000-0000000000ef",
  "00000000-0000-4000-8000-0000000000ff",
  "00000000-0000-4000-8000-000000000101",
  "00000000-0000-4000-8000-000000000201",
  "00000000-0000-4000-8000-000000000301",
  "00000000-0000-4000-8000-000000000401",
  "00000000-0000-4000-8000-000000000501",
  "00000000-0000-4000-8000-000000000601",
  "00000000-0000-4000-8000-000000000701",
  "00000000-0000-4000-8000-000000000801",
  "00000000-0000-4000-8000-000000000901",
  "00000000-0000-4000-8000-000000000abc",
  "00000000-0000-4000-8000-000000000ddd",
  "00000000-0000-4000-8000-000000000eee",
  "00000000-0000-4000-8000-000000001001",
  "00000000-0000-4000-8000-000000001101",
  "00000000-0000-4000-8000-000000009001",
  "00000000-0000-4000-8000-000000009101",
  "00000000-0000-4000-8000-00000000a001",
  "00000000-0000-4000-8000-00000000a002",
  "00000000-0000-4000-8000-00000000b001",
  "00000000-0000-4000-8000-00000000b002",
] as const;

/**
 * Ready-made CurrentUser literals for the most common actors, so new files
 * stop hand-writing them. Ids are inside the reserved fixture namespace and
 * covered by TEST_ACTOR_IDS, so `seedTestActors` provisions them.
 */
export function operatorUser(): CurrentUser {
  return {
    id: "00000000-0000-4000-8000-000000000401",
    email: "op@test.local",
    name: "Operator",
    role: "operator",
  };
}

export function adminUser(): CurrentUser {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@test.local",
    name: "Admin",
    role: "admin",
  };
}

export function clientViewerUser(): CurrentUser {
  return {
    id: "00000000-0000-4000-8000-00000000a002",
    email: "client@example.com",
    name: "Client Viewer",
    role: "client_viewer",
  };
}

/**
 * Provision every fixture actor. Call once per file after migrating, and
 * again after any truncate that clears `users`.
 *
 * All get `admin` because these tests exercise domain behaviour, not
 * authorisation — the role gates have their own dedicated tests in
 * `auth-and-roles.test.ts`, where the role is set deliberately per case.
 */
export async function seedTestActors(sql: Sql): Promise<void> {
  await sql`
    insert into users (id, email, name, role)
    select id, 'fixture+' || id || '@avos.local', 'Fixture Actor', 'admin'
    from unnest(${TEST_ACTOR_IDS as unknown as string[]}::uuid[]) as id
    on conflict (id) do nothing
  `;
}
