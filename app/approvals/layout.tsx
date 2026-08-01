import { requireStaffPage } from "@/lib/security/page-gates";

export default async function ApprovalsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireStaffPage();
  return <>{children}</>;
}
