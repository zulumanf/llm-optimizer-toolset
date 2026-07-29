"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { onboardClient, previewPrompts } from "@/app/onboarding/actions";
import type { PackVariable, ClaimKeySuggestion } from "@/lib/verticals/types";

interface PackOption {
  key: string;
  name: string;
  description: string;
  version: number;
  variables: PackVariable[];
  claimKeys: ClaimKeySuggestion[];
  promptCount: number;
  complianceCount: number;
}

interface PreviewPrompt {
  text: string;
  category: string;
  tier: number;
  isHoldout: boolean;
}

const lines = (value: string): string[] =>
  value
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export function OnboardingWizard({ packs }: { packs: PackOption[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [packKey, setPackKey] = useState(packs[0]?.key ?? "");
  const [clientName, setClientName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [aliases, setAliases] = useState("");
  const [domain, setDomain] = useState("");
  const [variables, setVariables] = useState<Record<string, string>>({});
  const [facts, setFacts] = useState<{ key: string; text: string; url: string }[]>([]);
  const [competitors, setCompetitors] = useState("");
  const [preview, setPreview] = useState<PreviewPrompt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pack = packs.find((p) => p.key === packKey);

  const variablePayload = (): Record<string, string[]> => {
    const payload: Record<string, string[]> = {};
    for (const variable of pack?.variables ?? []) {
      const raw = variables[variable.key] ?? "";
      payload[variable.key] = variable.multi ? lines(raw) : lines(raw).slice(0, 1);
    }
    return payload;
  };

  const competitorList = () =>
    lines(competitors).map((line) => {
      const [name, competitorDomain] = line.split("|").map((s) => s.trim());
      return {
        name: name ?? line,
        domain: competitorDomain || null,
        tier: "secondary" as const,
      };
    });

  const runPreview = () =>
    startTransition(async () => {
      setError(null);
      const result = await previewPrompts({
        packKey,
        variables: variablePayload(),
        brand: companyName,
        competitors: competitorList().map((c) => c.name),
      });
      setPreview(result);
      if (result.length === 0) {
        setError("No prompts generated — fill in the required inputs above.");
      }
    });

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await onboardClient({
        clientName,
        packKey,
        company: {
          name: companyName,
          aliases: lines(aliases),
          domain: domain || null,
        },
        variables: variablePayload(),
        facts: facts
          .filter((f) => f.key && f.text && f.url)
          .map((f) => ({ key: f.key, text: f.text, evidenceUrl: f.url })),
        competitors: competitorList(),
      });
      if (result.ok) {
        toast.success(
          `Client onboarded — ${result.data.promptsCreated} prompts generated for review.`
        );
        router.push(`/projects/${result.data.projectId}/prompts`);
      } else {
        setError(result.error.message);
      }
    });

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 flex items-center gap-2 text-lg font-medium">
          <Sparkles className="size-4" /> 1 · Vertical
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          {packs.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => {
                setPackKey(option.key);
                setPreview(null);
              }}
              className="text-left"
            >
              <Card
                className={
                  option.key === packKey
                    ? "h-full border-primary"
                    : "h-full transition-colors hover:bg-accent/50"
                }
              >
                <CardContent className="p-4">
                  <p className="text-sm font-medium">{option.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {option.description}
                  </p>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {option.promptCount} templates ·{" "}
                    {option.complianceCount} compliance rule
                    {option.complianceCount === 1 ? "" : "s"} · v{option.version}
                  </p>
                </CardContent>
              </Card>
            </button>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-lg font-medium">
          <Building2 className="size-4" /> 2 · The client
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ob-client">Engagement name</Label>
            <Input
              id="ob-client"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Gambino Group — NYC"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ob-company">Brand name (as people say it)</Label>
            <Input
              id="ob-company"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Gambino Group"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ob-domain">Domain</Label>
            <Input
              id="ob-domain"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              placeholder="gambinogroup.com"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ob-aliases">Aliases (one per line)</Label>
            <Textarea
              id="ob-aliases"
              rows={2}
              value={aliases}
              onChange={(e) => setAliases(e.target.value)}
              placeholder={"Gambino Team\ngambinogroup.com"}
            />
          </div>
        </div>
      </section>

      {pack && pack.variables.length > 0 && (
        <section>
          <h2 className="mb-2 text-lg font-medium">3 · Market inputs</h2>
          <div className="space-y-4">
            {pack.variables.map((variable) => (
              <div key={variable.key} className="space-y-1.5">
                <Label htmlFor={`var-${variable.key}`}>
                  {variable.label}
                  {variable.required && <span className="text-destructive"> *</span>}
                </Label>
                <Textarea
                  id={`var-${variable.key}`}
                  rows={variable.multi ? 3 : 1}
                  value={variables[variable.key] ?? ""}
                  onChange={(e) => {
                    setVariables((prev) => ({
                      ...prev,
                      [variable.key]: e.target.value,
                    }));
                    setPreview(null);
                  }}
                  placeholder={variable.example}
                />
                <p className="text-xs text-muted-foreground">
                  {variable.help}
                  {variable.multi ? " One per line." : ""}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 flex items-center gap-2 text-lg font-medium">
          <Users className="size-4" /> 4 · Competitors
        </h2>
        <Textarea
          rows={4}
          value={competitors}
          onChange={(e) => {
            setCompetitors(e.target.value);
            setPreview(null);
          }}
          placeholder={"Compass | compass.com\nDouglas Elliman | elliman.com"}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          One per line, optionally <code>Name | domain</code>. The first two
          also fill comparison prompts.
        </p>
      </section>

      {pack && (
        <section>
          <h2 className="mb-2 text-lg font-medium">5 · Verified facts</h2>
          <p className="mb-2 text-xs text-muted-foreground">
            Each fact becomes an approved claim, and every claim needs an
            evidence URL. These are the only facts agents may use about the
            client. Standard keys for this vertical:{" "}
            {pack.claimKeys.map((c) => c.key).join(", ")}.
          </p>
          <div className="space-y-3">
            {facts.map((fact, index) => (
              <div key={index} className="grid gap-2 sm:grid-cols-[10rem_1fr_12rem]">
                <Input
                  value={fact.key}
                  onChange={(e) =>
                    setFacts((prev) =>
                      prev.map((f, i) => (i === index ? { ...f, key: e.target.value } : f))
                    )
                  }
                  placeholder="category_positioning"
                />
                <Input
                  value={fact.text}
                  onChange={(e) =>
                    setFacts((prev) =>
                      prev.map((f, i) => (i === index ? { ...f, text: e.target.value } : f))
                    )
                  }
                  placeholder={pack.claimKeys[0]?.example ?? "The canonical fact"}
                />
                <Input
                  value={fact.url}
                  onChange={(e) =>
                    setFacts((prev) =>
                      prev.map((f, i) => (i === index ? { ...f, url: e.target.value } : f))
                    )
                  }
                  placeholder="https://evidence…"
                />
              </div>
            ))}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                setFacts((prev) => [
                  ...prev,
                  {
                    key: pack.claimKeys[prev.length]?.key ?? "",
                    text: "",
                    url: "",
                  },
                ])
              }
            >
              Add fact
            </Button>
          </div>
        </section>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">6 · Generated benchmark</h2>
          <Button variant="outline" size="sm" onClick={runPreview} disabled={pending}>
            {pending ? "Working…" : "Preview prompts"}
          </Button>
        </div>
        {preview && preview.length > 0 && (
          <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border p-3">
            {preview.map((prompt, index) => (
              <div key={index} className="flex items-start gap-2 text-sm">
                <Badge variant="outline" className="mt-0.5 shrink-0">
                  T{prompt.tier}
                </Badge>
                <span className="flex-1">{prompt.text}</span>
                {prompt.isHoldout && (
                  <Badge variant="secondary" className="shrink-0">holdout</Badge>
                )}
              </div>
            ))}
            <p className="pt-2 text-xs text-muted-foreground">
              {preview.length} prompts. You&rsquo;ll review and edit these before
              freezing — nothing runs yet.
            </p>
          </div>
        )}
      </section>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end gap-2 border-t pt-4">
        <Button
          onClick={submit}
          disabled={pending || !clientName || !companyName || !packKey}
        >
          {pending ? "Onboarding…" : "Create client"}
        </Button>
      </div>
    </div>
  );
}
