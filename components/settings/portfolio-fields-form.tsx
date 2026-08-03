"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  currentContractValue: number | null;
}

export function PortfolioFieldsForm({
  projectId,
  owners,
  currentOwnerId,
  currentTier,
  currentContractValue,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [ownerId, setOwnerId] = useState(currentOwnerId ?? NONE);
  const [tier, setTier] = useState(currentTier ?? NONE);
  const [contractValue, setContractValue] = useState(
    currentContractValue === null ? "" : String(currentContractValue)
  );

  const submit = () => {
    const parsedValue = contractValue.trim() === "" ? null : Number(contractValue);
    if (parsedValue !== null && (!Number.isFinite(parsedValue) || parsedValue < 0)) {
      toast.error("Contract value must be a non-negative number, or empty to unset.");
      return;
    }
    startTransition(async () => {
      const result = await updatePortfolioFields({
        projectId,
        accountOwnerId: ownerId === NONE ? null : ownerId,
        serviceTier: tier === NONE ? null : tier,
        contractValueUsd: parsedValue,
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
      <div className="space-y-1.5">
        <Label>Annual contract value (USD)</Label>
        <Input
          value={contractValue}
          onChange={(e) => setContractValue(e.target.value)}
          inputMode="decimal"
          placeholder="Empty = weight this client by provider spend instead"
          className="max-w-xs tabular-nums"
        />
        <p className="text-xs text-muted-foreground">
          Used by the control tower&apos;s priority formula. Until set, this
          client&apos;s commercial weight falls back to 30-day provider spend.
        </p>
      </div>
      <Button size="sm" onClick={submit} disabled={pending}>
        {pending ? "Saving…" : "Save portfolio fields"}
      </Button>
    </div>
  );
}
