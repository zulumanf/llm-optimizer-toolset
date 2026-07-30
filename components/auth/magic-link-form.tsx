"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" className="mt-3 w-full" disabled={pending}>
      {pending ? "Sending…" : "Send sign-in link"}
    </Button>
  );
}

export function MagicLinkForm({
  action,
}: {
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action} className="mt-6">
      <Label htmlFor="email">Work email</Label>
      <Input
        id="email"
        name="email"
        type="email"
        autoComplete="email"
        required
        autoFocus
        placeholder="you@example.com"
        className="mt-1"
      />
      <SubmitButton />
    </form>
  );
}
