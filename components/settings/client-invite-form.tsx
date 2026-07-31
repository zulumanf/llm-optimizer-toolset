"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { inviteClient } from "@/app/projects/actions";

export function ClientInviteForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");

  const submit = () => {
    startTransition(async () => {
      const result = await inviteClient({ projectId, email, name });
      if (result.ok) {
        toast.success(
          result.data.existing
            ? "Existing client account granted access."
            : "Invited — they sign in with a magic link to this email."
        );
        setEmail("");
        setName("");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1.5">
        <Label htmlFor="invite-email">Client email</Label>
        <Input
          id="invite-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="client@example.com"
          className="w-64"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="invite-name">Name</Label>
        <Input
          id="invite-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className="w-48"
        />
      </div>
      <Button
        size="sm"
        onClick={submit}
        disabled={pending || !email.trim() || !name.trim()}
      >
        {pending ? "Inviting…" : "Invite to portal"}
      </Button>
    </div>
  );
}
