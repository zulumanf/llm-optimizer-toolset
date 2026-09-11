import "dotenv/config";
import { sql } from "@/db/client";
async function main() {
  const rows = (await sql`
    select c.email, c.name, c.provenance, c.notes, p.business_name
    from prospect_contacts c join prospects p on p.id = c.prospect_id
    where lower(c.email) in ('patrick@southern.properties','dale.fior@bhsusa.com','info@kghometeam.com')
  `) as { email: string; name: string; provenance: string; notes: string | null; businessName: string }[];
  for (const r of rows) console.log(JSON.stringify(r, null, 1));
}
main().then(() => process.exit(0));
