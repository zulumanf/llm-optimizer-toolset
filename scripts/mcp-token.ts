/**
 * Personal-access-token admin for the remote MCP endpoint (spec 126).
 *
 * Usage:
 *   npm run mcp:token:create -- --name "grok-bot" [--test] [--email op@x.com]
 *   npx tsx scripts/mcp-token.ts list
 *   npx tsx scripts/mcp-token.ts revoke --id <token-id>
 *
 * The secret is printed ONCE and never stored — only its sha256 lands in
 * mcp_tokens. Tokens bind to a staff user (default: the oldest active
 * admin) and carry scope mcp:read.
 */
// Must be the first import — later imports read env at module load.
import "dotenv/config";

async function main(): Promise<void> {
  const { sql } = await import("@/db/client");
  const { mintToken, revokeToken } = await import("@/lib/mcp/remote-auth");

  const argv = process.argv.slice(2);
  const command = argv[0] ?? "create";
  const flag = (name: string): string | undefined => {
    const idx = argv.indexOf(`--${name}`);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  try {
    if (command === "create") {
      const name = flag("name");
      if (!name) throw new Error('--name is required, e.g. --name "grok-bot"');
      const email = flag("email");
      const [user] = email
        ? await sql`select id, email from users where email = ${email} and active`
        : await sql`
            select id, email from users
            where role = 'admin' and active
            order by created_at limit 1
          `;
      if (!user) throw new Error("no matching active staff user found");
      const minted = await mintToken({
        userId: user.id as string,
        name,
        prefix: argv.includes("--test") ? "rf_test_" : "rf_live_",
        createdBy: user.id as string,
      });
      console.log(`Token "${name}" bound to ${user.email as string} (id ${minted.id})`);
      console.log("");
      console.log("  SECRET (shown once, store it now):");
      console.log(`  ${minted.secret}`);
    } else if (command === "list") {
      const rows = await sql`
        select t.id, t.name, t.prefix, t.scopes, t.created_at, t.last_used_at,
          t.revoked_at, u.email
        from mcp_tokens t join users u on u.id = t.user_id
        order by t.created_at desc
      `;
      for (const r of rows) {
        const state = r.revokedAt ? "REVOKED" : "active";
        console.log(
          `${r.id as string}  ${state}  ${r.prefix as string}…  "${r.name as string}"  ${r.email as string}  scopes=${(r.scopes as string[]).join(",")}  last_used=${r.lastUsedAt ? new Date(r.lastUsedAt as Date).toISOString() : "never"}`
        );
      }
      if (rows.length === 0) console.log("no tokens");
    } else if (command === "revoke") {
      const id = flag("id");
      if (!id) throw new Error("--id is required");
      console.log((await revokeToken(id)) ? `revoked ${id}` : `not found or already revoked: ${id}`);
    } else {
      throw new Error(`unknown command "${command}" (create|list|revoke)`);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
