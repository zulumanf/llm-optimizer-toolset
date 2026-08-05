"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SERIES_SLOTS, CHART_INK, CHART_TOOLTIP } from "@/components/charts/palette";

export interface CompanyBarDatum {
  companyName: string;
  isSelf: boolean;
  value: number;
}

/** Latest authority score per company. One metric, one scale, one hue —
 * identity comes from the x-axis labels; direct value labels on data ends. */
export function AuthorityBarChart({ data }: { data: CompanyBarDatum[] }) {
  if (data.length === 0) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        No scored companies yet.
      </p>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 20, right: 16, bottom: 4, left: 0 }}>
        <CartesianGrid stroke={CHART_INK.grid} vertical={false} />
        <XAxis
          dataKey="companyName"
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
          cursor={{ fill: "rgba(127,127,127,0.08)" }}
          contentStyle={CHART_TOOLTIP.contentStyle}
          labelStyle={CHART_TOOLTIP.labelStyle}
        />
        <Bar
          dataKey="value"
          name="authority score"
          fill={SERIES_SLOTS[0]}
          radius={[4, 4, 0, 0]}
          maxBarSize={48}
          isAnimationActive={false}
        >
          <LabelList
            dataKey="value"
            position="top"
            formatter={(v) => (typeof v === "number" ? v.toFixed(1) : "")}
            fill={CHART_INK.muted}
            fontSize={11}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
