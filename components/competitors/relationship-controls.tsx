"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  proposeEntityRelationship,
  reviewEntityRelationship,
} from "@/app/projects/actions";
import type { RelationshipRow } from "@/lib/knowledge/entities/service";

const TYPE_LABELS: Record<string, string> = {
  works_for: "works for",
  brokerage: "is a team at",
  affiliated_with: "is affiliated with",
};

/** Propose and approve entity relationships (spec 056) — the write path
 * behind the groups rollup. A proposal is a hypothesis; approval is the
 * human decision that lets it group measurement. */
export function RelationshipControls({
  projectId,
  companies,
  relationships,
}: {
  projectId: string;
  companies: { id: string; name: string }[];
  relationships: RelationshipRow[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [fromCompanyId, setFromCompanyId] = useState("");
  const [toCompanyId, setToCompanyId] = useState("");
  const [relationshipType, setRelationshipType] = useState("brokerage");
  const [effectiveFrom, setEffectiveFrom] = useState("");

  const submit = () =>
    startTransition(async () => {
      const result = await proposeEntityRelationship({
        projectId,
        fromCompanyId,
        toCompanyId,
        relationshipType,
        effectiveFrom: effectiveFrom || undefined,
      });
      if (result.ok) {
        toast.success("Relationship proposed — approve it below to group measurement.");
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });

  const review = (relationshipId: string, decision: "approved" | "rejected") =>
    startTransition(async () => {
      const result = await reviewEntityRelationship({ relationshipId, decision });
      if (result.ok) toast.success(decision === "approved" ? "Approved." : "Rejected.");
      else toast.error(result.error.message);
    });

  const proposals = relationships.filter((r) => r.status === "proposed");

  return (
    <div className="mt-4 space-y-3">
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Link2 className="size-4" /> Link entities
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link a team to its brokerage</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="rel-from">Team / agent</Label>
              <Select value={fromCompanyId} onValueChange={setFromCompanyId}>
                <SelectTrigger id="rel-from">
                  <SelectValue placeholder="Pick the child entity" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rel-type">Relationship</Label>
              <Select value={relationshipType} onValueChange={setRelationshipType}>
                <SelectTrigger id="rel-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rel-to">Brokerage / parent</Label>
              <Select value={toCompanyId} onValueChange={setToCompanyId}>
                <SelectTrigger id="rel-to">
                  <SelectValue placeholder="Pick the parent entity" />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="rel-from-date">Effective from (optional)</Label>
              <Input
                id="rel-from-date"
                type="date"
                value={effectiveFrom}
                onChange={(e) => setEffectiveFrom(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submit}
              disabled={pending || !fromCompanyId || !toCompanyId || fromCompanyId === toCompanyId}
            >
              {pending ? "Proposing…" : "Propose"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {proposals.length > 0 && (
        <ul className="space-y-1 text-sm">
          {proposals.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2"
            >
              <span>
                <Badge variant="secondary">proposed</Badge>{" "}
                <span className="font-medium">{r.fromName}</span>{" "}
                <span className="text-muted-foreground">
                  {TYPE_LABELS[r.relationshipType] ?? r.relationshipType}
                </span>{" "}
                <span className="font-medium">{r.toName}</span>
              </span>
              <span className="inline-flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => review(r.id, "approved")}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => review(r.id, "rejected")}
                >
                  Reject
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
