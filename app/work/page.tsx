import Link from "next/link";
import { listOpenTasksAcrossProjects } from "@/lib/tasks/service";
import { PageShell, PageHeader, Section, EmptyState } from "@/components/layout/page";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export const dynamic = "force-dynamic";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
  suggested: "outline",
  approved: "secondary",
  in_progress: "default",
};

/** Cross-client work board (plan 5.1): every open task in the portfolio,
 * overdue first, then priority — the view that replaces opening ten
 * kanban pages to answer "what do we owe whom this week". */
export default async function WorkBoardPage() {
  const tasks = await listOpenTasksAcrossProjects();
  const overdue = tasks.filter((t) => t.overdue);

  return (
    <PageShell>
      <PageHeader
        title="Work"
        description="Every open task across every client — overdue first, then priority. Click through to the client's board to act."
      />
      <Section
        title={`Open tasks (${tasks.length})`}
        description={
          overdue.length > 0
            ? `${overdue.length} overdue — those come first.`
            : "Nothing overdue."
        }
      >
        {tasks.length === 0 ? (
          <EmptyState message="No open tasks anywhere. Suggest tasks from a client's gap findings to fill the board." />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead>Priority</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <Link
                        href={`/projects/${t.projectId}/tasks`}
                        className="font-medium hover:underline"
                      >
                        {t.projectName}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-md">
                      <span className="line-clamp-2">{t.title}</span>
                    </TableCell>
                    <TableCell>
                      <Badge variant={t.priority === "p1" ? "destructive" : "secondary"}>
                        {t.priority}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[t.status] ?? "outline"}>
                        {t.status.replaceAll("_", " ")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {t.ownerName ?? "unassigned"}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {t.dueDate ? (
                        <span className={t.overdue ? "font-medium text-destructive" : ""}>
                          {t.dueDate}
                          {t.overdue ? " · overdue" : ""}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </PageShell>
  );
}
