"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { recordClientOutcomeAction } from "@/app/operations/actions";

/** Manual monthly outcome capture. Blank means "not reported", never zero. */
export function OutcomeForm({ projectId }: { projectId: string }) {
  const [pending, start] = useTransition();
  const [periodStart, setStart] = useState("");
  const [periodEnd, setEnd] = useState("");
  const [provenance, setProvenance] = useState("self_reported");
  const [leads, setLeads] = useState("");
  const [ai, setAi] = useState("");
  const [closed, setClosed] = useState("");
  const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
  const submit = () =>
    start(async () => {
      const r = await recordClientOutcomeAction({
        projectId,
        periodStart,
        periodEnd,
        provenance,
        qualifiedLeads: num(leads),
        aiDiscoveryMentions: num(ai),
        closedTransactions: num(closed),
      });
      if (r.ok) {
        toast.success("Outcome recorded.");
        setLeads("");
        setAi("");
        setClosed("");
      } else toast.error(r.error.message);
    });
  return (
    <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
      <div className="grid gap-1">
        <Label htmlFor="o-start">Period start</Label>
        <Input id="o-start" type="date" value={periodStart} onChange={(e) => setStart(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="o-end">Period end</Label>
        <Input id="o-end" type="date" value={periodEnd} onChange={(e) => setEnd(e.target.value)} />
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor="o-prov">Where the numbers came from</Label>
        <Select value={provenance} onValueChange={setProvenance}>
          <SelectTrigger id="o-prov"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="self_reported">Client told us (self-reported)</SelectItem>
            <SelectItem value="client_system_export">Export from the client&apos;s own system</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="o-leads">Qualified leads</Label>
        <Input id="o-leads" inputMode="numeric" value={leads} onChange={(e) => setLeads(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="o-ai">Leads who said they found them through AI</Label>
        <Input id="o-ai" inputMode="numeric" value={ai} onChange={(e) => setAi(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="o-closed">Closed transactions (if volunteered)</Label>
        <Input id="o-closed" inputMode="numeric" value={closed} onChange={(e) => setClosed(e.target.value)} />
      </div>
      <Button onClick={submit} disabled={pending || !periodStart || !periodEnd}>{pending ? "Saving…" : "Record outcome"}</Button>
    </div>
  );
}
