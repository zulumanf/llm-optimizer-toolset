/**
 * Renders the priority formula's components under a queue row (spec 019).
 * A score the operator cannot decompose is not a score we are willing to show
 * (PRINCIPLES #4), so this is not optional decoration — it is the disclosure.
 */
import type { PriorityBreakdown } from "@/lib/workflow/exceptions";

export function PriorityBreakdownDetails({
  breakdown,
}: {
  breakdown: PriorityBreakdown;
}) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        Why {breakdown.total.toFixed(1)}? ({breakdown.formulaVersion})
      </summary>
      <table className="mt-1 text-xs text-muted-foreground">
        <tbody>
          {breakdown.components.map((component) => (
            <tr key={component.name}>
              <td className="pr-3">{component.name.replace(/([A-Z])/g, " $1").toLowerCase()}</td>
              <td className="pr-2 tabular-nums">weight {component.weight.toFixed(2)}</td>
              <td className="pr-2 tabular-nums">score {component.score.toFixed(2)}</td>
              <td className="tabular-nums">
                = {(component.contribution * 100).toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
