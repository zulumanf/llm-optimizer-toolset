"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setSubjectCompany } from "@/app/knowledge/actions";

interface Props {
  projectId: string;
  currentCompanyId: string | null;
  companies: { id: string; name: string }[];
}

export function SubjectSelector({ projectId, currentCompanyId, companies }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [companyId, setCompanyId] = useState(currentCompanyId ?? "");
  const dirty = companyId !== (currentCompanyId ?? "");

  return (
    <div className="flex items-center gap-2">
      <Select value={companyId} onValueChange={setCompanyId}>
        <SelectTrigger className="w-72">
          <SelectValue placeholder="Select the client company…" />
        </SelectTrigger>
        <SelectContent>
          {companies.map((c) => (
            <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {dirty && (
        <Button
          size="sm"
          disabled={pending || !companyId}
          onClick={() =>
            startTransition(async () => {
              const result = await setSubjectCompany({ projectId, companyId });
              if (result.ok) {
                toast.success("Subject set — this project now measures that company.");
                router.refresh();
              } else {
                toast.error(result.error.message);
              }
            })
          }
        >
          {pending ? "Saving…" : "Set subject"}
        </Button>
      )}
    </div>
  );
}
