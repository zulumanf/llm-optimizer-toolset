import "server-only";
import { sql } from "@/db/client";

/** Insert shape for a marketing-site audit request (spec 061). */
export interface NewAuditRequest {
  name: string;
  email: string;
  company: string | null;
  website: string | null;
  market: string;
  specialization: string | null;
}

export async function insertAuditRequest(req: NewAuditRequest): Promise<void> {
  await sql`
    insert into audit_requests (name, email, company, website, market, specialization)
    values (${req.name}, ${req.email}, ${req.company}, ${req.website},
            ${req.market}, ${req.specialization})
  `;
}
