"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  addOrganizationEntityAction,
  createOrganizationAction,
  grantOrganizationAccessAction,
} from "@/app/organizations/actions";

export function CreateOrganizationForm() {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1">
        <Label htmlFor="org-name">Brokerage name</Label>
        <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <Button
        disabled={pending || name.trim().length < 2}
        onClick={() =>
          start(async () => {
            const r = await createOrganizationAction({ name });
            if (r.ok) { toast.success("Organization created."); setName(""); } else toast.error(r.error.message);
          })
        }
      >
        Create
      </Button>
    </div>
  );
}

export function AddMemberForm({ organizationId, companies }: { organizationId: string; companies: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [level, setLevel] = useState("team");
  const match = companies.find((c) => c.name === name);
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1">
        <Label htmlFor="member-name">Measured agent or team</Label>
        <Input id="member-name" list="member-companies" value={name} onChange={(e) => setName(e.target.value)} className="w-72" />
        <datalist id="member-companies">
          {companies.map((c) => <option key={c.id} value={c.name} />)}
        </datalist>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="member-level">Level</Label>
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger id="member-level" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="individual">Individual</SelectItem>
            <SelectItem value="team">Team</SelectItem>
            <SelectItem value="office">Office</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button
        disabled={pending || !match}
        onClick={() =>
          start(async () => {
            const r = await addOrganizationEntityAction({ organizationId, companyId: match!.id, level });
            if (r.ok) { toast.success("Member added."); setName(""); } else toast.error(r.error.message);
          })
        }
      >
        Add
      </Button>
    </div>
  );
}

export function GrantAccessForm({ organizationId, users }: { organizationId: string; users: { id: string; email: string }[] }) {
  const [pending, start] = useTransition();
  const [userId, setUserId] = useState(users[0]?.id ?? "");
  if (users.length === 0) return <p className="text-sm text-muted-foreground">No client accounts exist yet; invite the brokerage contact first.</p>;
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="grid gap-1">
        <Label htmlFor="grant-user">Client account</Label>
        <Select value={userId} onValueChange={setUserId}>
          <SelectTrigger id="grant-user" className="w-72"><SelectValue /></SelectTrigger>
          <SelectContent>
            {users.map((u) => <SelectItem key={u.id} value={u.id}>{u.email}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Button
        disabled={pending || !userId}
        onClick={() =>
          start(async () => {
            const r = await grantOrganizationAccessAction({ organizationId, userId });
            if (r.ok) toast.success("Read-only access granted."); else toast.error(r.error.message);
          })
        }
      >
        Grant read-only access
      </Button>
    </div>
  );
}
