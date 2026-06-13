"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DayBucket } from "@/lib/insights";
import { fmtTokens, fmtDate } from "@/lib/format";

const PHOS = "#f5b54a";
const CITE = "#8fb9a8";
const YOU = "#c7b9e8";
const LINE = "#2a2620";
const BONE_FAINT = "#5f594b";

const axis = { stroke: BONE_FAINT, fontSize: 11, fontFamily: "Spline Sans Mono, monospace" };

function ChartTip({ active, payload, label, fmt }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#131210", border: `1px solid ${LINE}`, padding: "8px 11px", fontSize: 12 }}>
      <div style={{ color: BONE_FAINT, marginBottom: 4 }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ color: p.color }}>
          {p.name}: {fmt ? fmt(p.value) : p.value}
        </div>
      ))}
    </div>
  );
}

export function TokensTrend({ data }: { data: DayBucket[] }) {
  const rows = data.map((d) => ({ day: fmtDate(d.day), fresh: d.freshTokens, cache: d.cacheReadTokens }));
  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="gFresh" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PHOS} stopOpacity={0.5} />
            <stop offset="100%" stopColor={PHOS} stopOpacity={0.04} />
          </linearGradient>
          <linearGradient id="gCache" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={CITE} stopOpacity={0.4} />
            <stop offset="100%" stopColor={CITE} stopOpacity={0.03} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={LINE} vertical={false} />
        <XAxis dataKey="day" {...axis} tickLine={false} />
        <YAxis {...axis} tickLine={false} width={44} tickFormatter={(v) => fmtTokens(v)} />
        <Tooltip content={<ChartTip fmt={fmtTokens} />} />
        <Area type="monotone" dataKey="cache" name="cache reads" stroke={CITE} fill="url(#gCache)" strokeWidth={1.5} />
        <Area type="monotone" dataKey="fresh" name="fresh tokens" stroke={PHOS} fill="url(#gFresh)" strokeWidth={1.5} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function ActivityByHour({ data }: { data: { hour: number; exchanges: number }[] }) {
  const rows = data.map((d) => ({ hour: `${String(d.hour).padStart(2, "0")}`, exchanges: d.exchanges }));
  const peak = Math.max(...data.map((d) => d.exchanges), 0);
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={LINE} vertical={false} />
        <XAxis dataKey="hour" {...axis} tickLine={false} interval={2} />
        <YAxis {...axis} tickLine={false} width={28} allowDecimals={false} />
        <Tooltip content={<ChartTip />} cursor={{ fill: "rgba(245,181,74,0.06)" }} />
        <Bar dataKey="exchanges" name="exchanges">
          {rows.map((r, i) => (
            <Cell key={i} fill={data[i]!.exchanges === peak && peak > 0 ? PHOS : "#6c5a33"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function FrictionTrend({ data }: { data: DayBucket[] }) {
  const rows = data.map((d) => ({ day: fmtDate(d.day), corrections: d.corrections, errors: d.errors }));
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={LINE} vertical={false} />
        <XAxis dataKey="day" {...axis} tickLine={false} />
        <YAxis {...axis} tickLine={false} width={28} allowDecimals={false} />
        <Tooltip content={<ChartTip />} cursor={{ fill: "rgba(245,181,74,0.06)" }} />
        <Bar dataKey="corrections" name="corrections" stackId="f" fill={YOU} />
        <Bar dataKey="errors" name="tool errors" stackId="f" fill="#b4543f" />
      </BarChart>
    </ResponsiveContainer>
  );
}
