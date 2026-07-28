"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import {
  approveTask,
  rejectTask,
  startTask,
  completeTask,
  completeTaskAsIntervention,
} from "@/app/attribution/actions";

export interface TaskWithEvidence {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  evidence: { id: string; kind: string; refId: string; note: string }[] | null;
}

interface Props {
  task: TaskWithEvidence;
  projectId: string;
  versions: { id: string; label: string }[];
}

export function TaskCard({ task, projectId, versions }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [interventionOpen, setInterventionOpen] = useState(false);
  const [shippedAt, setShippedAt] = useState(new Date().toISOString().slice(0, 10));
  const [urls, setUrls] = useState("");
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  void projectId;

  const act = (
    fn: () => Promise<{ ok: boolean; error?: { message: string } }>,
    done: string
  ) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(done);
        setInterventionOpen(false);
        router.refresh();
      } else {
        toast.error(result.error?.message ?? "Action failed.");
      }
    });

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium">{task.title}</p>
          <Badge variant={task.priority === "p1" ? "destructive" : "outline"}>
            {task.priority}
          </Badge>
        </div>
        {task.description && (
          <p className="text-xs text-muted-foreground">{task.description}</p>
        )}
        {(task.evidence ?? []).length > 0 && (
          <div className="flex flex-wrap gap-1">
            {(task.evidence ?? []).map((e) => (
              <Badge key={e.id} variant="secondary" title={e.note}>
                {e.kind}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-1.5 pt-1">
          {task.status === "suggested" && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => act(() => rejectTask({ taskId: task.id }), "Rejected.")}
              >
                Reject
              </Button>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => act(() => approveTask({ taskId: task.id }), "Approved.")}
              >
                Approve
              </Button>
            </>
          )}
          {task.status === "approved" && (
            <Button
              size="sm"
              disabled={pending}
              onClick={() => act(() => startTask({ taskId: task.id }), "Started.")}
            >
              Start
            </Button>
          )}
          {task.status === "in_progress" && (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => act(() => completeTask({ taskId: task.id }), "Done.")}
              >
                Done
              </Button>
              <Button
                size="sm"
                disabled={pending}
                onClick={() => setInterventionOpen(true)}
              >
                Done + measure
              </Button>
            </>
          )}
        </div>
      </CardContent>

      <Dialog open={interventionOpen} onOpenChange={setInterventionOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Complete as intervention</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor={`ship-${task.id}`}>Shipped on</Label>
                <Input
                  id={`ship-${task.id}`}
                  type="date"
                  value={shippedAt}
                  onChange={(e) => setShippedAt(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Target version</Label>
                <Select value={versionId} onValueChange={setVersionId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`urls-${task.id}`}>URLs (comma-separated)</Label>
              <Input
                id={`urls-${task.id}`}
                value={urls}
                onChange={(e) => setUrls(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setInterventionOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              disabled={pending || !versionId}
              onClick={() =>
                act(
                  () =>
                    completeTaskAsIntervention({
                      taskId: task.id,
                      shippedAt,
                      urls: urls
                        .split(/[,\n]/)
                        .map((u) => u.trim())
                        .filter((u) => u.length > 0),
                      promptSetVersionId: versionId,
                    }),
                  "Done — intervention recorded, post runs scheduled."
                )
              }
            >
              {pending ? "Working…" : "Complete & measure"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
