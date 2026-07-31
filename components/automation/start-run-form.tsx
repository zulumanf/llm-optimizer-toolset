"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FlaskConical, Play } from "lucide-react";
import { startAutomationRun } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Start a run.
 *
 * Test mode is the default and the primary button. Live mode is a separate,
 * secondary action behind an explicit confirmation, because the two are not
 * symmetric: a needless test run costs nothing, and an unintended live run can
 * email a prospect or publish a page.
 */
export function StartRunForm({
  workflowKey,
  clientScope,
  fixtureNames,
}: {
  workflowKey: string;
  clientScope: "client_required" | "platform_only" | "either";
  fixtureNames: string[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [reason, setReason] = useState("");
  const [projectId, setProjectId] = useState("");
  const [fixtureName, setFixtureName] = useState(fixtureNames[0] ?? "");
  const [confirmingLive, setConfirmingLive] = useState(false);

  const needsProject = clientScope === "client_required";

  function run(mode: "live" | "test") {
    startTransition(async () => {
      const result = await startAutomationRun({
        workflowKey,
        projectId: needsProject ? projectId : null,
        mode,
        reason,
        fixtureName: mode === "test" && fixtureName.length > 0 ? fixtureName : undefined,
      });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      toast.success(
        mode === "test"
          ? "Test run started. It cannot send, publish, or invoice."
          : "Live run started."
      );
      setConfirmingLive(false);
      router.push(`/automation/runs/${result.data.runId}`);
    });
  }

  return (
    <div className="rounded-lg border p-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div>
          <Label htmlFor="reason">Reason (recorded on the run)</Label>
          <Input
            id="reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="why you are running this"
            className="mt-1"
          />
        </div>
        {needsProject ? (
          <div>
            <Label htmlFor="projectId">Client (project id)</Label>
            <Input
              id="projectId"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              placeholder="uuid"
              className="mt-1 font-mono text-xs"
            />
          </div>
        ) : null}
        <div>
          <Label htmlFor="fixture">Fixture (test mode)</Label>
          <Input
            id="fixture"
            value={fixtureName}
            onChange={(event) => setFixtureName(event.target.value)}
            placeholder={fixtureNames.length > 0 ? fixtureNames.join(" / ") : "none stored"}
            className="mt-1"
          />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button onClick={() => run("test")} disabled={pending || reason.trim().length < 3}>
          <FlaskConical className="mr-1.5 size-4" />
          {pending ? "Starting…" : "Start test run"}
        </Button>

        {confirmingLive ? (
          <>
            <Button
              variant="destructive"
              onClick={() => run("live")}
              disabled={pending || reason.trim().length < 3}
            >
              <Play className="mr-1.5 size-4" />
              Confirm live run
            </Button>
            <Button variant="outline" onClick={() => setConfirmingLive(false)} disabled={pending}>
              Cancel
            </Button>
            <span className="text-xs text-destructive">
              A live run may contact people and change external systems. Approval
              gates still apply.
            </span>
          </>
        ) : (
          <Button variant="outline" onClick={() => setConfirmingLive(true)} disabled={pending}>
            Start live run…
          </Button>
        )}
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        A test run serves every connector read from its fixture and refuses every
        consequential action, recording the payload it would have sent. Without a
        fixture, nodes that need one fail with a clear message rather than
        inventing data.
      </p>
    </div>
  );
}
