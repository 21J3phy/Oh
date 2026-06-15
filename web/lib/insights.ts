// Insights computation — ported verbatim from ../../src/insights.ts (ADR 0007).
// Pure functions over exchange_metrics rows: time anatomy, token economy,
// friction, fun stats, the rabbit-hole detector, and the evidence-based Tips.
// No LLM, no embeddings — everything stays mechanical and explainable.
//
// Individual-only (ADR 0008): always scoped to the caller's OWN sessions.
// The dashboard never queries another author's exchange_metrics (RLS forbids
// it anyway: metrics_self policy is author_id = auth.uid()).
//
// Keep in sync with src/insights.ts — this is a faithful copy plus the
// `bucketByDay` / `efficiencySignals` helpers the charts need.

import type { MetricsRow } from "./types";

export const PROMPT_GAP_MAX_MS = 5 * 60_000;
export const AWAY_GAP_MAX_MS = 30 * 60_000;
export const RABBIT_HOLE_MIN_STREAK = 4;

function freshTokens(r: { input_tokens: number; output_tokens: number; cache_write_tokens: number }): number {
  return r.input_tokens + r.output_tokens + r.cache_write_tokens;
}

export interface StreakItem {
  isCorrection: boolean;
  errors: number;
  freshTokens: number;
}

export function streakItemFromRow(r: MetricsRow): StreakItem {
  return { isCorrection: r.is_correction, errors: r.errors, freshTokens: freshTokens(r) };
}

export function countRabbitHoleEpisodes(items: StreakItem[]): number {
  let episodes = 0;
  let run = 0;
  for (const it of items) {
    if (it.isCorrection || it.errors > 0) {
      run++;
      if (run === RABBIT_HOLE_MIN_STREAK) episodes++;
    } else {
      run = 0;
    }
  }
  return episodes;
}

export interface InsightsReport {
  author: string | null;
  sinceIso: string | null;
  exchanges: number;
  sessions: number;
  promptMs: number;
  awayMs: number;
  workMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheHitRate: number | null;
  topExchange: { sessionId: string; ts: string; repo: string | null; freshTokens: number } | null;
  corrections: number;
  errors: number;
  interrupts: number;
  rabbitHoleEpisodes: number;
  peakHour: number | null;
  busiestDay: string | null;
  longestSession: { sessionId: string; ms: number } | null;
}

export function computeInsights(
  rows: MetricsRow[],
  opts: { author?: string | null; sinceIso?: string | null } = {},
): InsightsReport {
  const report: InsightsReport = {
    author: opts.author ?? null,
    sinceIso: opts.sinceIso ?? null,
    exchanges: rows.length,
    sessions: 0,
    promptMs: 0,
    awayMs: 0,
    workMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRate: null,
    topExchange: null,
    corrections: 0,
    errors: 0,
    interrupts: 0,
    rabbitHoleEpisodes: 0,
    peakHour: null,
    busiestDay: null,
    longestSession: null,
  };
  if (rows.length === 0) return report;

  const sessions = new Map<string, MetricsRow[]>();
  const hourCounts = new Array<number>(24).fill(0);
  const dayCounts = new Map<string, number>();

  for (const r of rows) {
    const list = sessions.get(r.session_id);
    if (list) list.push(r);
    else sessions.set(r.session_id, [r]);

    if (r.think_ms != null) {
      if (r.think_ms <= PROMPT_GAP_MAX_MS) report.promptMs += r.think_ms;
      else if (r.think_ms <= AWAY_GAP_MAX_MS) report.awayMs += r.think_ms;
    }
    report.workMs += r.work_ms;

    report.inputTokens += r.input_tokens;
    report.outputTokens += r.output_tokens;
    report.cacheReadTokens += r.cache_read_tokens;
    report.cacheWriteTokens += r.cache_write_tokens;
    const fresh = freshTokens(r);
    if (!report.topExchange || fresh > report.topExchange.freshTokens) {
      report.topExchange = { sessionId: r.session_id, ts: r.ts, repo: r.repo, freshTokens: fresh };
    }

    if (r.is_correction) report.corrections++;
    report.errors += r.errors;
    if (r.interrupted) report.interrupts++;

    const d = new Date(r.ts);
    if (!Number.isNaN(d.getTime())) {
      hourCounts[d.getHours()]!++;
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);
    }
  }

  report.sessions = sessions.size;

  const denom = report.inputTokens + report.cacheReadTokens + report.cacheWriteTokens;
  report.cacheHitRate = denom > 0 ? report.cacheReadTokens / denom : null;

  for (const [sessionId, list] of sessions) {
    list.sort((a, b) => a.exchange_index - b.exchange_index);
    report.rabbitHoleEpisodes += countRabbitHoleEpisodes(list.map(streakItemFromRow));
    let active = 0;
    for (const r of list) {
      active += r.work_ms;
      if (r.think_ms != null && r.think_ms <= AWAY_GAP_MAX_MS) active += r.think_ms;
    }
    if (!report.longestSession || active > report.longestSession.ms) {
      report.longestSession = { sessionId, ms: active };
    }
  }

  let peak = 0;
  for (let h = 0; h < 24; h++) {
    if (hourCounts[h]! > peak) {
      peak = hourCounts[h]!;
      report.peakHour = h;
    }
  }
  let busiest = 0;
  for (const [day, n] of dayCounts) {
    if (n > busiest) {
      busiest = n;
      report.busiestDay = day;
    }
  }

  return report;
}

// ---- Efficiency signals (D9): real, explainable ratios — NOT a composite score.
export interface EfficiencySignal {
  key: string;
  label: string;
  value: string;
  /** 0..1 where higher is better, for the meter fill; null when N/A. */
  good: number | null;
  hint: string;
}

export function efficiencySignals(r: InsightsReport): EfficiencySignal[] {
  const signals: EfficiencySignal[] = [];

  // Cache hit rate — context reuse vs re-buying the same tokens.
  signals.push({
    key: "cache",
    label: "Cache hit rate",
    value: r.cacheHitRate != null ? `${Math.round(r.cacheHitRate * 100)}%` : "—",
    good: r.cacheHitRate,
    hint: "Cached context costs ~10× less than fresh. Higher is cheaper.",
  });

  // Rework rate — corrections per exchange.
  const reworkRate = r.exchanges > 0 ? r.corrections / r.exchanges : 0;
  signals.push({
    key: "rework",
    label: "Rework rate",
    value: r.exchanges > 0 ? `${Math.round(reworkRate * 100)}%` : "—",
    good: r.exchanges > 0 ? 1 - Math.min(reworkRate, 1) : null,
    hint: "Share of turns that were do-overs (\"no\", \"still broken\"). Lower is better.",
  });

  // Flow — agent work as a share of active time at the wheel (work + your prompting).
  const active = r.workMs + r.promptMs;
  const flow = active > 0 ? r.workMs / active : 0;
  signals.push({
    key: "flow",
    label: "Agent flow",
    value: active > 0 ? `${Math.round(flow * 100)}%` : "—",
    good: active > 0 ? flow : null,
    hint: "Share of active time the agent spent working vs you prompting.",
  });

  // Output density — fresh tokens spent per exchange (lower = tighter turns).
  const freshTotal = r.inputTokens + r.outputTokens + r.cacheWriteTokens;
  const perExchange = r.exchanges > 0 ? Math.round(freshTotal / r.exchanges) : 0;
  signals.push({
    key: "density",
    label: "Fresh tokens / turn",
    value: r.exchanges > 0 ? (perExchange >= 1000 ? `${Math.round(perExchange / 1000)}k` : String(perExchange)) : "—",
    good: null,
    hint: "Fresh (non-cached) tokens spent per exchange.",
  });

  return signals;
}

// ---- Daily buckets for the trend charts.

// Per-repo slice of a single day — "what you worked on", ranked by fresh spend.
export interface RepoDay {
  repo: string; // "unknown" when the session had no repo
  freshTokens: number;
  exchanges: number;
  sessions: number;
}

export interface DayBucket {
  day: string; // YYYY-MM-DD
  freshTokens: number;
  cacheReadTokens: number;
  workMs: number;
  promptMs: number;
  awayMs: number;
  exchanges: number;
  corrections: number;
  errors: number;
  sessions: number; // distinct sessions touched that day
  repos: RepoDay[]; // ranked by freshTokens desc — the day's "what"
}

export function bucketByDay(rows: MetricsRow[]): DayBucket[] {
  const buckets = new Map<string, DayBucket>();
  // Side accumulators (kept off DayBucket so the public shape stays plain data).
  const daySessions = new Map<string, Set<string>>();
  const dayRepos = new Map<string, Map<string, { freshTokens: number; exchanges: number; sessions: Set<string> }>>();

  for (const r of rows) {
    const d = new Date(r.ts);
    if (Number.isNaN(d.getTime())) continue;
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    let b = buckets.get(day);
    if (!b) {
      b = { day, freshTokens: 0, cacheReadTokens: 0, workMs: 0, promptMs: 0, awayMs: 0, exchanges: 0, corrections: 0, errors: 0, sessions: 0, repos: [] };
      buckets.set(day, b);
      daySessions.set(day, new Set());
      dayRepos.set(day, new Map());
    }
    const fresh = r.input_tokens + r.output_tokens + r.cache_write_tokens;
    b.freshTokens += fresh;
    b.cacheReadTokens += r.cache_read_tokens;
    b.workMs += r.work_ms;
    if (r.think_ms != null) {
      if (r.think_ms <= PROMPT_GAP_MAX_MS) b.promptMs += r.think_ms;
      else if (r.think_ms <= AWAY_GAP_MAX_MS) b.awayMs += r.think_ms;
    }
    b.exchanges += 1;
    if (r.is_correction) b.corrections += 1;
    b.errors += r.errors;

    daySessions.get(day)!.add(r.session_id);
    const repoKey = r.repo ?? "unknown";
    const repos = dayRepos.get(day)!;
    let agg = repos.get(repoKey);
    if (!agg) {
      agg = { freshTokens: 0, exchanges: 0, sessions: new Set() };
      repos.set(repoKey, agg);
    }
    agg.freshTokens += fresh;
    agg.exchanges += 1;
    agg.sessions.add(r.session_id);
  }

  for (const [day, b] of buckets) {
    b.sessions = daySessions.get(day)!.size;
    b.repos = [...dayRepos.get(day)!.entries()]
      .map(([repo, a]) => ({ repo, freshTokens: a.freshTokens, exchanges: a.exchanges, sessions: a.sessions.size }))
      .sort((x, y) => y.freshTokens - x.freshTokens);
  }

  return [...buckets.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ---- Hour-of-day histogram for the activity chart.
export function bucketByHour(rows: MetricsRow[]): { hour: number; exchanges: number }[] {
  const counts = new Array<number>(24).fill(0);
  for (const r of rows) {
    const d = new Date(r.ts);
    if (!Number.isNaN(d.getTime())) counts[d.getHours()]!++;
  }
  return counts.map((exchanges, hour) => ({ hour, exchanges }));
}
