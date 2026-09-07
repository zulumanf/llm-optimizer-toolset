"use client";

import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CompanyFormDialog } from "@/components/companies/company-form-dialog";
import { useAction } from "@/lib/hooks/use-action";
import { archiveCompany } from "@/app/classification/actions";
import type { Company } from "@/db/companies";

interface Props {
  company: Company;
  isAdmin: boolean;
}

export function CompanyRowControls({ company, isAdmin }: Props) {
  const { pending, run } = useAction();

  return (
    <div className="flex justify-end gap-0.5">
      <CompanyFormDialog mode="edit" company={company} isAdmin={isAdmin} />
      {isAdmin && !company.isSelf && (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Archive company"
          disabled={pending}
          onClick={() =>
            run(() => archiveCompany({ id: company.id }), {
              success: "Company archived.",
              refresh: true,
            })
          }
        >
          <Archive className="size-4" />
        </Button>
      )}
    </div>
  );
}
