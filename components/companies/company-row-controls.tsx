"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CompanyFormDialog } from "@/components/companies/company-form-dialog";
import { archiveCompany } from "@/app/classification/actions";
import type { Company } from "@/db/companies";

interface Props {
  company: Company;
  isAdmin: boolean;
}

export function CompanyRowControls({ company, isAdmin }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

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
            startTransition(async () => {
              const result = await archiveCompany({ id: company.id });
              if (result.ok) {
                toast.success("Company archived.");
                router.refresh();
              } else {
                toast.error(result.error.message);
              }
            })
          }
        >
          <Archive className="size-4" />
        </Button>
      )}
    </div>
  );
}
