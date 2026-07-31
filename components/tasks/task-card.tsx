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
import { Textarea } from "@/components/ui/textarea";
import {
  approveTask,
  rejectTask,
  startTask,
  completeTask,
  completeTaskAsIntervention,
  updateTaskDetails,
  addTaskComment,
} from "@/app/attribution/actions";
import type { TaskListItem } from "@/lib/tasks/service";
import type { StaffUser } from "@/db/users";

// Select rejects empty-string values, so "no owner" needs a sentinel.
const UNASSIGNED = "unassigned";

interface Props {
  task: TaskListItem;
  projectId: string;
  versions: { id: string; label: string }[];
  staff: StaffUser[];
}

export function TaskCard({ task, projectId, versions, staff }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [interventionOpen, setInterventionOpen] = useState(false);
  const [shippedAt, setShippedAt] = useState(new Date().toISOString().slice(0, 10));
  const [urls, setUrls] = useState("");
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [ownerId, setOwnerId] = useState(task.ownerId ?? UNASSIGNED);
  const [dueDate, setDueDate] = useState(task.dueDate ?? "");
  const [clientVisible, setClientVisible] = useState(task.clientVisible);
  const [commentBody, setCommentBody] = useState("");
  void projectId;

  const ownerLabel = task.ownerName || task.ownerEmail;

  const act = (
    fn: () => Promise<{ ok: boolean; error?: { message: string } }>,
    done: string,
    opts?: { keepOpen?: boolean }
  ) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(done);
        setInterventionOpen(false);
        if (!opts?.keepOpen) setDetailsOpen(false);
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
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          {ownerLabel ? (
            <span>{ownerLabel}</span>
          ) : (
            <span className="text-muted-foreground">unassigned</span>
          )}
          {task.dueDate && (
            <span className={task.overdue ? "font-medium text-destructive" : "text-muted-foreground"}>
              due {task.dueDate}
              {task.overdue ? " (overdue)" : ""}
            </span>
          )}
          {task.clientVisible && <Badge variant="secondary">client-visible</Badge>}
        </div>
        {task.evidence.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {task.evidence.map((e) => (
              <Badge key={e.id} variant="secondary" title={e.note}>
                {e.kind}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-1.5 pt-1">
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => setDetailsOpen(true)}
          >
            Details{task.comments.length > 0 ? ` (${task.comments.length})` : ""}
          </Button>
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

      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Task details</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Owner</Label>
                <Select value={ownerId} onValueChange={setOwnerId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {staff.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name || s.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`due-${task.id}`}>Due date</Label>
                <Input
                  id={`due-${task.id}`}
                  type="date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id={`cv-${task.id}`}
                checked={clientVisible}
                onChange={(e) => setClientVisible(e.target.checked)}
              />
              <Label htmlFor={`cv-${task.id}`}>
                Visible to client (off by default — exposure is an explicit choice)
              </Label>
            </div>
            <div className="space-y-2">
              <Label>Comments</Label>
              {task.comments.length === 0 ? (
                <p className="text-xs text-muted-foreground">No comments yet.</p>
              ) : (
                <div className="max-h-48 space-y-2 overflow-y-auto">
                  {task.comments.map((c) => (
                    <div key={c.id} className="rounded-md border p-2">
                      <p className="text-xs text-muted-foreground">
                        {c.author} — {c.createdAt}
                      </p>
                      <p className="whitespace-pre-wrap text-sm">{c.body}</p>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <Textarea
                  rows={2}
                  placeholder="Add a comment (append-only)…"
                  value={commentBody}
                  onChange={(e) => setCommentBody(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending || commentBody.trim().length === 0}
                  onClick={() =>
                    act(
                      async () => {
                        const result = await addTaskComment({
                          taskId: task.id,
                          body: commentBody.trim(),
                        });
                        if (result.ok) setCommentBody("");
                        return result;
                      },
                      "Comment added.",
                      { keepOpen: true }
                    )
                  }
                >
                  Comment
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setDetailsOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                act(
                  () =>
                    updateTaskDetails({
                      taskId: task.id,
                      ownerId: ownerId === UNASSIGNED ? null : ownerId,
                      dueDate: dueDate === "" ? null : dueDate,
                      clientVisible,
                    }),
                  "Task updated."
                )
              }
            >
              {pending ? "Working…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
