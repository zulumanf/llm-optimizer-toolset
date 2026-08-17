/**
 * Backfill branded audit links (spec 076) for every prospect with a
 * published audit, and print the full URL list for the operator's emails.
 *
 * Run with:  npx tsx scripts/mint-audit-links.ts          (dry run)
 *            APPLY=1 npx tsx scripts/mint-audit-links.ts  (mint)
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { mintAuditLink, auditLinkForProspect } from "@/lib/prospects/links";
import { brandedAuditUrl } from "@/lib/prospects/urls";
import type { CurrentUser } from "@/lib/auth";

async function main(): Promise<void> {
  const [operator] = await sql`
    select id, email, name, role from users where email = 'zulumanf@gmail.com'
  `;
  if (!operator) throw new Error("Operator user not found.");
  const user: CurrentUser = {
    id: operator.id as string,
    email: operator.email as string,
    name: operator.name as string,
    role: operator.role as CurrentUser["role"],
  };

  const prospects = await sql`
    select distinct p.id, p.business_name from prospects p
    join prospect_audits a on a.prospect_id = p.id and a.status = 'published'
    where p.archived_at is null
    order by p.business_name asc
  `;
  console.log(`prospects with published audits: ${prospects.length}`);

  for (const prospect of prospects) {
    const existing = await auditLinkForProspect(prospect.id as string);
    if (existing) {
      console.log(
        `= ${prospect.businessName}: ${brandedAuditUrl(existing.slug, existing.key)}`
      );
      continue;
    }
    if (process.env.APPLY !== "1") {
      console.log(`~ ${prospect.businessName}: would mint (dry run)`);
      continue;
    }
    const minted = await mintAuditLink(user, { prospectId: prospect.id as string });
    if (minted.ok) {
      console.log(
        `+ ${prospect.businessName}: ${brandedAuditUrl(minted.data.slug, minted.data.key)}`
      );
    } else {
      console.log(`! ${prospect.businessName}: ${minted.error.message}`);
    }
  }
  if (process.env.APPLY !== "1") console.log("\nDry run — set APPLY=1 to mint.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
