/**
 * The empty state every async view needs (docs/04). Deliberately explains *why*
 * a view is empty and what would fill it — an unexplained blank panel is
 * indistinguishable from a broken one.
 */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed p-8 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-prose text-sm text-muted-foreground">{body}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
