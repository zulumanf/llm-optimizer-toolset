"use client";

import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { scenarioTable, type ScenarioAssumptions } from "@/lib/economics/scenarios";

type Inputs = Omit<ScenarioAssumptions, "annualRevenueUsd">;

const FIELDS: { key: keyof Inputs; label: string }[] = [
  { key: "annualRevenuePerClientUsd", label: "Annual revenue per client" },
  { key: "inferenceCostPerClientMonthUsd", label: "Inference / client-month" },
  { key: "thirdPartyCostPerClientMonthUsd", label: "Other APIs / client-month" },
  { key: "laborHoursPerClientMonth", label: "Labor hours / client-month" },
  { key: "loadedHourlyRateUsd", label: "Loaded hourly rate" },
  { key: "fixedPlatformCostPerYearUsd", label: "Platform infra / year" },
  { key: "salesAndMarketingPerYearUsd", label: "Sales & marketing / year" },
  { key: "generalAndAdminPerYearUsd", label: "G&A / year" },
  { key: "researchAndDevelopmentPerYearUsd", label: "R&D / year" },
];

const pct = (v: number) => `${(v * 100).toFixed(0)}%`;

/** Every input is an assumption the operator types in; the table is a
 * what-would-have-to-be-true view, never a forecast. Starts empty. */
export function ScenarioCalculator() {
  const [values, setValues] = useState<Record<keyof Inputs, string>>(
    Object.fromEntries(FIELDS.map((f) => [f.key, ""])) as Record<keyof Inputs, string>
  );
  const parsed = useMemo(() => {
    const out: Partial<Inputs> = {};
    for (const f of FIELDS) {
      const n = Number(values[f.key]);
      if (values[f.key].trim() === "" || !Number.isFinite(n) || n < 0) return null;
      out[f.key] = n;
    }
    return out.annualRevenuePerClientUsd ? (out as Inputs) : null;
  }, [values]);
  const rows = parsed ? scenarioTable(parsed, [0.5, 0.6]) : null;
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map((f) => (
          <div key={f.key} className="grid gap-1">
            <Label htmlFor={`sc-${f.key}`}>{f.label}</Label>
            <Input id={`sc-${f.key}`} inputMode="decimal" value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
          </div>
        ))}
      </div>
      {rows ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Revenue (hypothetical)</TableHead>
              <TableHead className="text-right">Clients</TableHead>
              <TableHead className="text-right">Gross margin</TableHead>
              <TableHead className="text-right">EBITDA margin</TableHead>
              <TableHead className="text-right">Max labor h/client-month for 50%</TableHead>
              <TableHead className="text-right">… for 60%</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.annualRevenueUsd}>
                <TableCell className="tabular-nums">${(r.annualRevenueUsd / 1e6).toFixed(1)}M</TableCell>
                <TableCell className="text-right tabular-nums">{r.clients.toFixed(0)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.grossMargin)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.ebitdaMargin)}</TableCell>
                {[0.5, 0.6].map((t) => {
                  const h = r.maxLaborHours[t] ?? 0;
                  return <TableCell key={t} className="text-right tabular-nums">{h < 0 ? "unreachable" : h.toFixed(1)}</TableCell>;
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm text-muted-foreground">Fill every assumption to see the table. Nothing is pre-filled: these are your assumptions, not measured figures.</p>
      )}
    </div>
  );
}
