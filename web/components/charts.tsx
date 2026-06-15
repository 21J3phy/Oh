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

// A day's one-line "what I worked on" — the top repos by fresh spend that day.
function daySummary(d: DayBucket): string {
  const repos = d.repos.filter((r) => r.repo !== "unknown");
  const named = (repos.length ? repos : d.repos).slice(0, 2).map((r) => r.repo);
  if (named.length === 0) return "";
  const more = d.repos.length - named.length;
  return named.join(" · ") + (more > 0 ? ` +${more}` : "");
}

// Indices that are relative maxima worth labelling: a local max in total tokens
// that clears a noise floor (15% of the window's tallest day). Endpoints count
// when they out-rank their single neighbour.
function peakIndices(totals: number[]): number[] {
  const max = Math.max(...totals, 0);
  if (max <= 0) return [];
  const floor = max * 0.15;
  const out: number[] = [];
  for (let i = 0; i < totals.length; i++) {
    const v = totals[i]!;
    if (v < floor) continue;
    const l = i > 0 ? totals[i - 1]! : -Infinity;
    const r = i < totals.length - 1 ? totals[i + 1]! : -Infinity;
    if (v >= l && v >= r) out.push(i);
  }
  return out;
}

export function TokensTrend({ data }: { data: DayBucket[] }) {
  const rows = data.map((d) => ({
    day: fmtDate(d.day),
    fresh: d.freshTokens,
    cache: d.cacheReadTokens,
    summary: daySummary(d),
  }));
  const peaks = new Set(peakIndices(data.map((d) => d.freshTokens + d.cacheReadTokens)));

  // Custom dot on the (visually dominant) cache curve: label the day's work at peaks.
  const PeakLabel = (props: { cx?: number; cy?: number; index?: number }) => {
    const { cx, cy, index } = props;
    if (cx == null || cy == null || index == null || !peaks.has(index)) return <g />;
    const summary = rows[index]?.summary;
    if (!summary) return <g />;
    return (
      <g>
        <circle cx={cx} cy={cy} r={3} fill={PHOS} stroke="#131210" strokeWidth={1.5} />
        <text x={cx} y={cy - 11} textAnchor="middle" fill="#e8e0d0" fontSize={11} fontFamily="Spline Sans Mono, monospace" style={{ letterSpacing: "0.02em" }}>
          {summary}
        </text>
      </g>
    );
  };

  return (
    <ResponsiveContainer width="100%" height={240}>
      <AreaChart data={rows} margin={{ top: 26, right: 12, left: 0, bottom: 0 }}>
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
        <Area type="monotone" dataKey="fresh" name="fresh tokens" stroke={PHOS} fill="url(#gFresh)" strokeWidth={1.5} />
        <Area type="monotone" dataKey="cache" name="cache reads" stroke={CITE} fill="url(#gCache)" strokeWidth={1.5} dot={<PeakLabel />} activeDot={false} />
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
