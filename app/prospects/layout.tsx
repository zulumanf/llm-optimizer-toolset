import { requireStaffPage } from "@/lib/security/page-gates";

/** Staff-only segment (spec 032): prospecting intelligence never reaches
 * client roles — every page below is gated by construction. */
export default async function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireStaffPage();
  return children;
}
