"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updatePortfolioFields } from "@/app/projects/actions";

const NONE = "__none__";
const TIERS = ["standard", "premium", "exclusive"] as const;

interface Props {
  projectId: string;
  owners: { id: string; name: string; email: string }[];
  currentOwnerId: string | null;
  currentTier: string | null;
}

export function PortfolioFieldsForm({
  projectId,
  owners,
  currentOwnerId,
  currentTier,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [ownerId, setOwnerId] = useState(currentOwnerId ?? NONE);
  const [tier, setTier] = useState(currentTier ?? NONE);

  const submit = () => {
    startTransition(async () => {
      const result = await updatePortfolioFields({
        projectId,
        accountOwnerId: ownerId === NONE ? null : ownerId,
        serviceTier: tier === NONE ? null : tier,
      });
      if (result.ok) {
        toast.success("Portfolio fields saved.");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label>Account owner</Label>
          <Select value={ownerId} onValueChange={setOwnerId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Unassigned</SelectItem>
              {owners.map((o) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name || o.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Service tier</Label>
          <Select value={tier} onValueChange={setTier}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Unset</SelectItem>
              {TIERS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <Button size="sm" onClick={submit} disabled={pending}>
        {pending ? "Saving…" : "Save portfolio fields"}
      </Button>
    </div>
  );
}
