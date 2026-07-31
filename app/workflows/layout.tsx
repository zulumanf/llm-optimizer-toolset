import { requireStaffPage } from "@/lib/security/page-gates";

/** Staff-only segment (spec 031): every page below is gated by construction. */
export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireStaffPage();
  return children;
}
