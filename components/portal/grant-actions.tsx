"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { revokeClientPortalAccess, setClientUserActive } from "@/app/projects/actions";

/** Admin row actions for a portal grant (spec 052): close the door, or
 * disable the login entirely. Both audited server-side. */
export function GrantActions({
  projectId,
  userId,
  active,
}: {
  projectId: string;
  userId: string;
  active: boolean;
}) {
  const [pending, startTransition] = useTransition();

  const revoke = () =>
    startTransition(async () => {
      const result = await revokeClientPortalAccess({ userId, projectId });
      if (result.ok) toast.success("Portal access revoked.");
      else toast.error(result.error.message);
    });

  const toggleActive = () =>
    startTransition(async () => {
      const result = await setClientUserActive({ userId, active: !active });
      if (result.ok) toast.success(active ? "Login deactivated." : "Login reactivated.");
      else toast.error(result.error.message);
    });

  return (
    <span className="inline-flex gap-2">
      <Button variant="outline" size="sm" onClick={revoke} disabled={pending}>
        Revoke access
      </Button>
      <Button variant="outline" size="sm" onClick={toggleActive} disabled={pending}>
        {active ? "Deactivate login" : "Reactivate login"}
      </Button>
    </span>
  );
}
