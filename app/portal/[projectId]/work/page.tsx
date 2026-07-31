import { portalWork } from "@/lib/portal/service";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  task: "Work item",
  content: "Content",
  intervention: "Shipped change",
};

/** Proof of work (spec 031 / roadmap 3.2): only client-visible completions,
 * published content, and shipped interventions — filtered in SQL. */
export default async function PortalWorkPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const items = await portalWork(projectId);

  return (
    <div>
      <h2 className="mb-1 text-lg font-medium">Work delivered</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Completed work your agency has shared, published content, and shipped
        changes — each shipped change is automatically re-measured on a
        schedule.
      </p>
      {items.length === 0 ? (
        <p className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
          Nothing shared yet — delivered work appears here as it completes.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => (
            <li
              key={`${item.kind}-${i}`}
              className="flex items-start gap-3 rounded-md border p-3 text-sm"
            >
              <Badge variant="outline">{KIND_LABEL[item.kind]}</Badge>
              <div>
                <p className="font-medium">{item.title}</p>
                <p className="text-xs text-muted-foreground">
                  {formatDate(item.at)}
                  {item.detail ? ` · ${item.detail}` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
