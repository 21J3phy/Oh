"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/components/auth";
import { TokensTrend, TokensByAgent, ActivityByHour, FrictionTrend } from "@/components/charts";
import { fetchOwnMetrics, fetchOwnChunkTexts } from "@/lib/queries";
import {
  computeInsights,
  efficiencySignals,
  bucketByDay,
  bucketByHour,
  type InsightsReport,
  type EfficiencySignal,
  type DayBucket,
} from "@/lib/insights";
import { generateTips, type Tip } from "@/lib/tips";
import type { MetricsRow } from "@/lib/types";
import { fmtDuration, fmtTokens, fmtDate } from "@/lib/format";

const WINDOWS: { key: string; label: string; days: number | null }[] = [
  { key: "7d", label: "7 days", days: 7 },
  { key: "30d", label: "30 days", days: 30 },
  { key: "90d", label: "90 days", days: 90 },
  { key: "all", label: "All time", days: null },
];

function sinceIsoFor(days: number | null): string | null {
  if (days == null) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export default function DashboardPage() {
  return (
    <AppShell>
      <Dashboard />
    </AppShell>
  );
}

function Dashboard() {
  const { session, activeTeam } = useAuth();
  const [win, setWin] = useState("30d");
  const [rows, setRows] = useState<MetricsRow[] | null>(null);
  const [chunkTexts, setChunkTexts] = useState<Array<{ id: string; text: string }>>([]);
  const [err, setErr] = useState<string | null>(null);

  const userId = session?.user?.id;

  const load = useCallback(async () => {
    if (!userId) return;
    setRows(null);
    setErr(null);
    const days = WINDOWS.find((w) => w.key === win)?.days ?? 30;
    const since = sinceIsoFor(days);
    try {
      const [m, c] = await Promise.all([fetchOwnMetrics(since), fetchOwnChunkTexts(userId, since)]);
      setRows(m);
      setChunkTexts(c);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load insights.");
      setRows([]);
    }
  }, [userId, win]);

  useEffect(() => {
    void load();
  }, [load]);

  const report: InsightsReport | null = useMemo(() => (rows ? computeInsights(rows) : null), [rows]);
  const today: InsightsReport | null = useMemo(() => {
    if (!rows) return null;
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const dayIso = dayStart.toISOString();
    return computeInsights(rows.filter((r) => r.ts >= dayIso));
  }, [rows]);
  const signals: EfficiencySignal[] = useMemo(() => (report ? efficiencySignals(report) : []), [report]);
  const days: DayBucket[] = useMemo(() => (rows ? bucketByDay(rows) : []), [rows]);
  const hours = useMemo(() => (rows ? bucketByHour(rows) : []), [rows]);
  const tips: Tip[] = useMemo(() => (rows ? generateTips(rows, chunkTexts) : []), [rows, chunkTexts]);

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 32, flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 28, letterSpacing: "-0.04em" }}>
            Your vibecoding
          </h1>
          <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
            {activeTeam ? `${activeTeam.author_name} · ` : ""}from your own captured sessions — private to you (ADR 0008).
          </p>
        </div>
        <div className="topnav" style={{ gap: 6 }}>
          {WINDOWS.map((w) => (
            <button key={w.key} className={`btn sm ${win === w.key ? "" : "ghost"}`} onClick={() => setWin(w.key)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="err">{err}</p>}
      {!rows && !err && <p className="spinner" style={{ marginTop: 40 }}>computing your insights…</p>}

      {report && report.exchanges === 0 && (
        <p className="empty">No captured exchanges in this window. Run `oh backfill`, or widen the range.</p>
      )}

      {report && report.exchanges > 0 && (
        <>
          {/* today — at-a-glance "how's today going" before the full window */}
          {today && today.exchanges > 0 && <TodaySummary today={today} days={days} />}

          {/* headline numbers */}
          <div className="grid cols-4" style={{ marginTop: 24 }}>
            <Stat num={String(report.sessions)} sub="sessions" />
            <Stat num={String(report.exchanges)} sub="exchanges" />
            <Stat num={fmtTokens(report.inputTokens + report.outputTokens + report.cacheWriteTokens)} sub="fresh tokens" accent />
            <Stat num={fmtDuration(report.promptMs + report.awayMs + report.workMs)} sub="time at the wheel" />
          </div>

          {/* time anatomy */}
          <div className="section-title">Time anatomy — &ldquo;hours worked&rdquo;</div>
          <div className="card">
            <TimeAnatomy report={report} />
          </div>

          {/* trends */}
          <div className="section-title">Tokens over time</div>
          <div className="card">
            {days.length > 1 ? <TokensTrend data={days} /> : <p className="faint">Not enough days in this window to chart a trend.</p>}
          </div>

          {/* per-agent token split */}
          <div className="section-title">Tokens by agent</div>
          <div className="card">
            {days.length > 1 ? <TokensByAgent data={days} /> : <p className="faint">Not enough days in this window to chart a trend.</p>}
          </div>

          <div className="grid cols-2">
            <div>
              <div className="section-title">Activity by hour</div>
              <div className="card">
                <ActivityByHour data={hours} />
              </div>
            </div>
            <div>
              <div className="section-title">Friction over time</div>
              <div className="card">
                {days.length > 1 ? <FrictionTrend data={days} /> : <p className="faint">Not enough days to chart.</p>}
              </div>
            </div>
          </div>

          {/* efficiency signals */}
          <div className="section-title">Efficiency signals</div>
          <p className="faint" style={{ fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
            Real, explainable ratios — not a single &ldquo;score&rdquo;. Read each next to the others.
          </p>
          <div className="grid cols-4">
            {signals.map((s) => (
              <SignalCard key={s.key} signal={s} />
            ))}
          </div>

          {/* friction + fun summary */}
          <div className="grid cols-2" style={{ marginTop: 16 }}>
            <div className="card">
              <h3>Friction</h3>
              <KV k="Corrections (do-overs)" v={String(report.corrections)} />
              <KV k="Tool errors" v={String(report.errors)} />
              <KV k="Interrupts (Esc)" v={String(report.interrupts)} />
              <KV k="Rabbit-hole episodes" v={String(report.rabbitHoleEpisodes)} />
            </div>
            <div className="card">
              <h3>Notables</h3>
              <KV k="Peak hour" v={report.peakHour != null ? `${String(report.peakHour).padStart(2, "0")}:00` : "—"} />
              <KV k="Busiest day" v={report.busiestDay ? fmtDate(report.busiestDay) : "—"} />
              <KV k="Longest session" v={report.longestSession ? fmtDuration(report.longestSession.ms) : "—"} />
              <KV
                k="Priciest exchange"
                v={report.topExchange ? `${fmtTokens(report.topExchange.freshTokens)} · ${report.topExchange.repo ?? "?"}` : "—"}
              />
            </div>
          </div>

          {/* text insights */}
          {tips.length > 0 && (
            <>
              <div className="section-title">What stands out</div>
              {tips.map((t, i) => (
                <p key={i} className="tip">
                  {t.text}
                </p>
              ))}
            </>
          )}

          <p className="faint" style={{ fontSize: 11.5, margin: "28px 0 40px" }}>
            Gaps ≤5m count as prompting, 5–30m as away, &gt;30m excluded. Tokens are counts, not cost. Everything here is from
            your own captured sessions and visible only to you.
          </p>
        </>
      )}
    </main>
  );
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function TodaySummary({ today, days }: { today: InsightsReport; days: DayBucket[] }) {
  const wall = today.promptMs + today.awayMs + today.workMs;
  const fresh = today.inputTokens + today.outputTokens + today.cacheWriteTokens;

  // Baseline = average over prior active days in this window (today excluded).
  const prior = days.filter((d) => d.day !== todayKey());
  const n = prior.length;
  const avg = n
    ? {
        wall: prior.reduce((s, d) => s + d.promptMs + d.awayMs + d.workMs, 0) / n,
        fresh: prior.reduce((s, d) => s + d.freshTokens, 0) / n,
        sessions: prior.reduce((s, d) => s + d.sessions, 0) / n,
        exchanges: prior.reduce((s, d) => s + d.exchanges, 0) / n,
      }
    : null;

  const num = (x: number) => x.toLocaleString();
  const fix1 = (x: number) => x.toFixed(1);
  const stats: { label: string; val: number; avg: number | undefined; fmt: (n: number) => string; fmtAvg: (n: number) => string; accent?: boolean }[] = [
    { label: "time at the wheel", val: wall, avg: avg?.wall, fmt: fmtDuration, fmtAvg: fmtDuration },
    { label: "fresh tokens", val: fresh, avg: avg?.fresh, fmt: fmtTokens, fmtAvg: fmtTokens, accent: true },
    { label: "sessions", val: today.sessions, avg: avg?.sessions, fmt: num, fmtAvg: fix1 },
    { label: "exchanges", val: today.exchanges, avg: avg?.exchanges, fmt: num, fmtAvg: fix1 },
  ];

  return (
    <>
      <div className="section-title" style={{ marginTop: 24 }}>Today</div>
      <div className="grid cols-4">
        {stats.map((s) => (
          <TodayStat key={s.label} {...s} />
        ))}
      </div>
    </>
  );
}

function TodayStat({
  label,
  val,
  avg,
  fmt,
  fmtAvg,
  accent,
}: {
  label: string;
  val: number;
  avg: number | undefined;
  fmt: (n: number) => string;
  fmtAvg: (n: number) => string;
  accent?: boolean;
}) {
  let cmp: { text: string; up: boolean } | null = null;
  if (avg != null && avg > 0) {
    const pct = Math.round(((val - avg) / avg) * 100);
    cmp = { text: `${pct >= 0 ? "+" : ""}${pct}% vs ${fmtAvg(avg)}/day`, up: pct >= 0 };
  }
  return (
    <div className="card stat">
      <div className={`num ${accent ? "accent" : ""}`}>{fmt(val)}</div>
      <div className="sub">{label}</div>
      {cmp && (
        <div className="faint" style={{ fontSize: 11.5, marginTop: 8 }} title="compared with your average active day in this window">
          {cmp.text}
        </div>
      )}
    </div>
  );
}

function Stat({ num, sub, accent, you }: { num: string; sub: string; accent?: boolean; you?: boolean }) {
  return (
    <div className="card stat">
      <div className={`num ${accent ? "accent" : you ? "you" : ""}`}>{num}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="row">
      <span className="muted">{k}</span>
      <span style={{ fontFamily: "var(--display)", fontWeight: 500 }}>{v}</span>
    </div>
  );
}

function TimeAnatomy({ report }: { report: InsightsReport }) {
  const total = report.promptMs + report.workMs + report.awayMs || 1;
  const pPrompt = (report.promptMs / total) * 100;
  const pWork = (report.workMs / total) * 100;
  const pAway = (report.awayMs / total) * 100;
  return (
    <>
      <div className="anatomy">
        <span style={{ width: `${pPrompt}%`, background: "var(--you)" }} title="you prompting" />
        <span style={{ width: `${pWork}%`, background: "var(--phos)" }} title="agent working" />
        <span style={{ width: `${pAway}%`, background: "var(--bone-faint)" }} title="you away" />
      </div>
      <div className="legend">
        <span><i style={{ background: "var(--you)" }} />you prompting/thinking {fmtDuration(report.promptMs)}</span>
        <span><i style={{ background: "var(--phos)" }} />agent working {fmtDuration(report.workMs)}</span>
        <span><i style={{ background: "var(--bone-faint)" }} />you away {fmtDuration(report.awayMs)}</span>
      </div>
    </>
  );
}

function SignalCard({ signal }: { signal: EfficiencySignal }) {
  const fill = signal.good == null ? 0 : Math.round(signal.good * 100);
  const color = signal.good == null ? "var(--bone-dim)" : signal.good >= 0.7 ? "var(--phos)" : signal.good >= 0.4 ? "var(--phos-soft)" : "#b4543f";
  return (
    <div className="card stat" title={signal.hint}>
      <div className="num" style={{ fontSize: 26 }}>{signal.value}</div>
      <div className="sub">{signal.label}</div>
      {signal.good != null && (
        <div style={{ height: 4, background: "var(--ink)", border: "1px solid var(--line)", marginTop: 10 }}>
          <div style={{ width: `${fill}%`, height: "100%", background: color }} />
        </div>
      )}
    </div>
  );
}
