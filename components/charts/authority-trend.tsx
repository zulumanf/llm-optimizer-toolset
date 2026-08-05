"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  PROVIDER_COLORS,
  AGGREGATE_COLOR,
  CHART_INK,
  CHART_TOOLTIP,
} from "@/components/charts/palette";

export interface TrendDatum {
  runLabel: string;
  startedAt: string;
  scoringVersion: string;
  promptSetVersionId: string;
  /** provider → authority value */
  values: Record<string, number>;
}

interface Props {
  data: TrendDatum[];
  providers: string[];
}

/** Authority score over runs, one line per provider + dashed aggregate.
 * Version boundaries (scoring or frozen-set changes between consecutive
 * runs) are annotated — cross-boundary segments are not comparable trends
 * (docs/06 reporting rules). */
export function AuthorityTrendChart({ data, providers }: Props) {
  if (data.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No scored runs yet — the trend appears after the first run scores.
      </p>
    );
  }

  const boundaries: string[] = [];
  for (let i = 1; i < data.length; i += 1) {
    const prev = data[i - 1]!;
    const curr = data[i]!;
    if (
      prev.scoringVersion !== curr.scoringVersion ||
      prev.promptSetVersionId !== curr.promptSetVersionId
    ) {
      boundaries.push(curr.runLabel);
    }
  }

  const series = providers.filter((p) => data.some((d) => d.values[p] !== undefined));

  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid stroke={CHART_INK.grid} vertical={false} />
        <XAxis
          dataKey="runLabel"
          tick={{ fill: CHART_INK.muted, fontSize: 11 }}
          stroke={CHART_INK.axis}
          tickLine={false}
        />
        <YAxis
          domain={[0, 100]}
          width={32}
          tick={{ fill: CHART_INK.muted, fontSize: 11 }}
          stroke={CHART_INK.axis}
          tickLine={false}
        />
        <Tooltip
          contentStyle={CHART_TOOLTIP.contentStyle}
          labelStyle={CHART_TOOLTIP.labelStyle}
        />
        {series.length + 1 >= 2 && (
          <Legend wrapperStyle={{ fontSize: 12, color: CHART_INK.muted }} />
        )}
        {boundaries.map((label) => (
          <ReferenceLine
            key={label}
            x={label}
            stroke={CHART_INK.muted}
            strokeDasharray="4 4"
            label={{
              value: "new baseline",
              fill: CHART_INK.muted,
              fontSize: 10,
              position: "top",
            }}
          />
        ))}
        {series.map((provider) => (
          <Line
            key={provider}
            name={provider}
            dataKey={(d: TrendDatum) => d.values[provider] ?? null}
            stroke={PROVIDER_COLORS[provider] ?? AGGREGATE_COLOR}
            strokeWidth={2}
            dot={{ r: 4, fill: PROVIDER_COLORS[provider] ?? AGGREGATE_COLOR }}
            connectNulls
            isAnimationActive={false}
          />
        ))}
        <Line
          name="all providers"
          dataKey={(d: TrendDatum) => d.values.all ?? null}
          stroke={AGGREGATE_COLOR}
          strokeWidth={2}
          strokeDasharray="6 3"
          dot={{ r: 4, fill: AGGREGATE_COLOR }}
          connectNulls
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
