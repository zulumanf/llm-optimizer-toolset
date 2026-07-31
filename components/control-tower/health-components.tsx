/**
 * Client-health drill-down (spec 019 Part C). A missing component renders as
 * "no data" — never as a zero, because a zero is a judgement and an absence
 * is not.
 */
export function HealthComponents({
  components,
  missing,
}: {
  components: { name: string; weight: number; score: number | null; detail: string }[];
  missing: string[];
}) {
  if (components.length === 0) return null;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        Components ({components.length - missing.length} with data, {missing.length} missing)
      </summary>
      <table className="mt-1 w-full max-w-2xl text-xs">
        <tbody>
          {components.map((component) => (
            <tr key={component.name} className="align-top">
              <td className="w-48 pr-3 text-muted-foreground">
                {component.name.replace(/_/g, " ")}
              </td>
              <td className="w-16 pr-3 tabular-nums text-muted-foreground">
                ×{component.weight.toFixed(2)}
              </td>
              <td className="w-16 pr-3 tabular-nums">
                {component.score === null ? (
                  <span className="text-muted-foreground">no data</span>
                ) : (
                  component.score.toFixed(2)
                )}
              </td>
              <td className="text-muted-foreground">{component.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
