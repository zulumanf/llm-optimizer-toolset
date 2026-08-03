import { requireStaffPage } from "@/lib/security/page-gates";

export default async function WorkLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireStaffPage();
  return children;
}
