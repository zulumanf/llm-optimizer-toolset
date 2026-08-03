/**
 * Actor resolution for the MCP server (spec 033). One operator identity per
 * process: MCP_USER_ID names a real users row, or dev mode falls back to the
 * dev user. The system principal is deliberately not used — MCP invocations
 * are operator-initiated, and "acted by a person" must stay distinguishable
 * from "acted by the platform" (migration 037's rationale, inverted).
 */
import { sql } from "@/db/client";
import { getEnv } from "@/lib/env";
import { DEV_USER_ID, isStaff, type CurrentUser, type Role } from "@/lib/auth";

/** Startup refusal — message is safe to print to the operator's terminal. */
export class McpActorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpActorError";
  }
}

export async function resolveMcpActor(): Promise<CurrentUser> {
  const env = getEnv();
  const userId = process.env.MCP_USER_ID;

  if (!userId) {
    if (env.AUTH_MODE === "supabase") {
      throw new McpActorError(
        "MCP_USER_ID is required under AUTH_MODE=supabase — the server refuses to guess an identity."
      );
    }
    return {
      id: DEV_USER_ID,
      email: env.DEV_USER_EMAIL,
      name: env.DEV_USER_NAME,
      role: env.DEV_USER_ROLE,
    };
  }

  const [row] = await sql`
    select id, email, name, role from users
    where id = ${userId} and active
  `;
  if (!row) {
    throw new McpActorError(
      "MCP_USER_ID does not match an active user — provision the account first."
    );
  }
  const actor: CurrentUser = {
    id: row.id as string,
    email: row.email as string,
    name: row.name as string,
    role: row.role as Role,
  };
  assertMcpActor(actor);
  return actor;
}

/** Staff only: client roles never get a tool surface, read or write. */
export function assertMcpActor(actor: CurrentUser): void {
  if (!isStaff(actor)) {
    throw new McpActorError(
      "MCP access is limited to staff roles (admin, operator, reviewer)."
    );
  }
}
