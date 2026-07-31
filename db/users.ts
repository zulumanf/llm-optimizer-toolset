import { sql } from "@/db/client";
import { STAFF_ROLES } from "@/lib/auth";

export interface StaffUser {
  id: string;
  name: string;
  email: string;
}

/** Active staff accounts — the only legal task owners (clients are read-only). */
export async function listActiveStaffUsers(): Promise<StaffUser[]> {
  const rows = await sql`
    select id, name, email from users
    where active and role = any(${STAFF_ROLES as string[]})
    order by name asc, email asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    name: row.name as string,
    email: row.email as string,
  }));
}
