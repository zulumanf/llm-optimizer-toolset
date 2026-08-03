"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { importProspects } from "@/app/prospects/actions";
import { PROVENANCE_LABELS } from "@/lib/prospects/constants";

interface ImportReport {
  created: number;
  duplicates: number;
  errors: { line: number; message: string }[];
  ignoredHeaders: string[];
}

export function ImportDialog({ launches }: { launches: { id: string; name: string }[] }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [launchId, setLaunchId] = useState<string>(launches[0]?.id ?? "");
  const [csv, setCsv] = useState("");
  const [provenance, setProvenance] = useState<string>("publicly_sourced");
  const [sourceUrl, setSourceUrl] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);

  const submit = () => {
    startTransition(async () => {
      const result = await importProspects({
        launchId,
        csv,
        provenance,
        sourceUrl: sourceUrl || undefined,
      });
      if (result.ok) {
        setReport(result.data as ImportReport);
        toast.success(`Imported ${(result.data as ImportReport).created} prospect(s).`);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setReport(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={launches.length === 0}>
          <Upload className="size-4" /> Import CSV
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import prospects from CSV</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Launch</Label>
              <Select value={launchId} onValueChange={setLaunchId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {launches.map((l) => (
                    <SelectItem key={l.id} value={l.id}>
                      {l.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Provenance for imported facts</Label>
              <Select value={provenance} onValueChange={setProvenance}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVENANCE_LABELS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p.replaceAll("_", " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-source">Source URL (where this list came from)</Label>
            <Input
              id="import-source"
              value={sourceUrl}
              onChange={(e) => setSourceUrl(e.target.value)}
              placeholder="https://therealdeal.com/…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="import-csv">CSV (header row required)</Label>
            <Textarea
              id="import-csv"
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              className="font-mono text-xs"
              placeholder={
                "business_name,type,team_leader,brokerage,website,email,contact_name,contact_email\nRivera Team,team,Ana Rivera,Compass,riverateam.com,hello@riverateam.com,Ana Rivera,ana@riverateam.com"
              }
            />
            <p className="text-xs text-muted-foreground">
              Recognized columns: business_name (or name/team), type, team_leader, brokerage,
              website, email, phone, price_segment, contact_name, contact_role, contact_email.
              Max 200 rows per file. Duplicates within the launch are skipped and counted.
            </p>
          </div>
          {report && (
            <div className="rounded-md border p-3 text-sm space-y-1">
              <p>
                Created <strong>{report.created}</strong> · duplicates skipped{" "}
                <strong>{report.duplicates}</strong> · errors <strong>{report.errors.length}</strong>
              </p>
              {report.ignoredHeaders.length > 0 && (
                <p className="text-muted-foreground">
                  Ignored columns: {report.ignoredHeaders.join(", ")}
                </p>
              )}
              {report.errors.length > 0 && (
                <ul className="max-h-32 overflow-y-auto text-destructive">
                  {report.errors.map((e, i) => (
                    <li key={i}>
                      Line {e.line}: {e.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !csv.trim() || !launchId}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
