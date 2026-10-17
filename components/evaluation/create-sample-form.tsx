"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createGoldSampleAction } from "@/app/evaluation/actions";

export function CreateSampleForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [size, setSize] = useState("200");
  const [seed, setSeed] = useState(String(new Date().getFullYear()));

  const submit = () =>
    startTransition(async () => {
      const result = await createGoldSampleAction({ name, size: Number(size), seed: Number(seed) });
      if (result.ok) {
        toast.success(`Sample created with ${result.data.size} pairs.`);
        router.push(`/evaluation/${result.data.sampleId}`);
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <div className="grid gap-3 sm:grid-cols-4 sm:items-end">
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor="gold-name">Sample name</Label>
        <Input id="gold-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Real-answer gold set, October" />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="gold-size">Pairs</Label>
        <Input id="gold-size" inputMode="numeric" value={size} onChange={(e) => setSize(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="gold-seed">Seed</Label>
        <Input id="gold-seed" inputMode="numeric" value={seed} onChange={(e) => setSeed(e.target.value)} />
      </div>
      <Button onClick={submit} disabled={pending || name.trim().length < 3} className="sm:col-span-4 sm:justify-self-start">
        {pending ? "Drawing sample…" : "Draw sample"}
      </Button>
    </div>
  );
}
