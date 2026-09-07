import { PageHeader, PageShell } from "@/components/layout/page";
import { Building2 } from "lucide-react";
import { listCompanies } from "@/db/companies";
import { getCurrentUser } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CompanyFormDialog } from "@/components/companies/company-form-dialog";
import { CompanyRowControls } from "@/components/companies/company-row-controls";

export default async function CompaniesPage() {
  const [companies, user] = await Promise.all([listCompanies(), getCurrentUser()]);
  const hasSelf = companies.some((c) => c.isSelf);

  return (
    <PageShell>
      <PageHeader
        title="Companies"
        description="Brands the parser tracks. Exactly one is the platform's own brand (is_self); aliases drive mention detection — collisions are blocked."
        actions={<CompanyFormDialog mode="create" isAdmin={user.role === "admin"} />}
      />

      {!hasSelf && (
        <div className="mb-4 rounded-md border border-warning/50 bg-warning/10 px-4 py-2 text-sm">
          No is_self company yet — parsing refuses to run until the platform&rsquo;s own
          brand is added with &ldquo;This is our own brand&rdquo; checked.
        </div>
      )}

      {companies.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <Building2 className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            No companies yet — add the platform&rsquo;s own brand first, then competitors.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Aliases</TableHead>
                <TableHead>Domain</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    {c.name}{" "}
                    {c.isSelf && <Badge className="ml-1">own brand</Badge>}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.aliases.length > 0 ? c.aliases.join(", ") : "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.domain ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <CompanyRowControls
                      company={c}
                      isAdmin={user.role === "admin"}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </PageShell>
  );
}
