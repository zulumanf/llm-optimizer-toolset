import { requireStaffPage } from "@/lib/security/page-gates";

/** Staff-only: the dogfood experiment is never a client or prospect surface. */
export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireStaffPage();
  return children;
}
