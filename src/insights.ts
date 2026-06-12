// Insights — the first Flags-family View (ADR 0007). Pure functions over
// exchange_metrics rows: time anatomy, token economy, friction, fun stats, and
// the rabbit-hole detector shared with capture's Nudge writer. No LLM, no
// embeddings — everything here must stay mechanical and explainable.
//
// Individual-only (ADR 0008): reports are always scoped to the caller's own
// Sessions. Do not add per-author roll-ups or team views here.

import type { MetricsRow } from "./db.js";

/** Think-gaps up to this long count as "you prompting/thinking". */
export const PROMPT_GAP_MAX_MS = 5 * 60_000;
/** Gaps up to this long count as "away while the agent waited"; longer = left for the day, excluded. */
export const AWAY_GAP_MAX_MS = 30 * 60_000;
/** Trailing correction/error streak that triggers the rabbit-hole Nudge. */
export const RABBIT_HOLE_MIN_STREAK = 4;

/** Tokens the exchange actually paid for (cache reads excluded). */
function freshTokens(r: { input_tokens: number; output_tokens: number; cache_write_tokens: number }): number {
  return r.input_tokens + r.output_tokens + r.cache_write_tokens;
}

/** The minimal shape the rabbit-hole detector needs (Exchange or MetricsRow). */
export interface StreakItem {
  isCorrection: boolean;
  errors: number;
  freshTokens: number;
}

export function streakItemFromRow(r: MetricsRow): StreakItem {
  return { isCorrection: r.is_correction, errors: r.errors, freshTokens: freshTokens(r) };
}

/**
 * The rabbit-hole signature: the *trailing* run of exchanges (in session order)
 * that are corrections or contain tool errors. Null until the run reaches
 * RABBIT_HOLE_MIN_STREAK.
 */
export function detectRabbitHole(items: StreakItem[]): { streak: number; tokens: number } | null {
  let streak = 0;
  let tokens = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (!it.isCorrection && it.errors === 0) break;
    streak++;
    tokens += it.freshTokens;
  }
  return streak >= RABBIT_HOLE_MIN_STREAK ? { streak, tokens } : null;
}

/** Count maximal correction/error runs of qualifying length — the retrospective view. */
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

export function formatNudge(streak: number, tokens: number): string {
  const k = Math.round(tokens / 1000);
  return (
    `Oh: the last ${streak} turns in this session look like a loop ` +
    `(corrections/errors back to back, ~${k}k tokens). ` +
    `A fresh start — /clear and restating the goal with what you've learned — is often cheaper than turn ${streak + 1}.`
  );
}

export interface InsightsReport {
  author: string | null;
  sinceIso: string | null;
  exchanges: number;
  sessions: number;
  /** Time anatomy (ms). wall = prompt + away + work. */
  promptMs: number;
  awayMs: number;
  workMs: number;
  /** Token economy. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite); null when no input at all. */
  cacheHitRate: number | null;
  topExchange: { sessionId: string; ts: string; repo: string | null; freshTokens: number } | null;
  /** Friction. */
  corrections: number;
  errors: number;
  interrupts: number;
  rabbitHoleEpisodes: number;
  /** Fun. */
  peakHour: number | null; // 0-23 local, by exchange count
  busiestDay: string | null; // YYYY-MM-DD local
  /** ms is ACTIVE time (work + counted gaps), not wall span — resumed sessions can span days. */
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
      // longer gaps = left for the day; excluded by design
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
    // rows arrive ts-ordered; the per-session detector + wall clock rely on exchange order
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

function fmtDuration(msTotal: number): string {
  const mins = Math.round(msTotal / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${mins % 60}m`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function formatInsights(r: InsightsReport): string {
  const who = r.author ? `${r.author}'s` : "Your";
  const since = r.sinceIso ? ` since ${r.sinceIso.slice(0, 10)}` : "";
  const lines: string[] = [`${who} vibecoding${since}`, ""];

  if (r.exchanges === 0) {
    lines.push("No captured exchanges in this window. (Run `oh backfill`, or widen --since.)");
    return lines.join("\n");
  }

  const wall = r.promptMs + r.awayMs + r.workMs;
  lines.push(`Sessions: ${r.sessions}   Exchanges: ${r.exchanges}`);
  lines.push("");
  lines.push(`Time at the wheel  ~${fmtDuration(wall)}`);
  lines.push(`  you prompting/thinking   ${fmtDuration(r.promptMs)}`);
  lines.push(`  agent working            ${fmtDuration(r.workMs)}`);
  lines.push(`  you away (agent waited)  ${fmtDuration(r.awayMs)}`);
  lines.push("");
  lines.push(
    `Tokens  ${fmtTokens(r.inputTokens + r.outputTokens + r.cacheWriteTokens)} fresh ` +
      `(${fmtTokens(r.outputTokens)} out) + ${fmtTokens(r.cacheReadTokens)} cache reads` +
      (r.cacheHitRate != null ? `   cache hit ${pct(r.cacheHitRate)}` : ""),
  );
  if (r.topExchange) {
    lines.push(
      `  most expensive exchange  ${fmtTokens(r.topExchange.freshTokens)} fresh tokens` +
        `  (${r.topExchange.repo ?? "?"}, ${r.topExchange.ts.slice(0, 16).replace("T", " ")})`,
    );
  }
  lines.push("");
  lines.push(
    `Friction  ${r.corrections} corrections · ${r.errors} tool errors · ` +
      `${r.interrupts} interrupts · ${r.rabbitHoleEpisodes} rabbit-hole episode${r.rabbitHoleEpisodes === 1 ? "" : "s"}`,
  );
  lines.push("");
  const fun: string[] = [];
  if (r.peakHour != null) fun.push(`peak hour ${String(r.peakHour).padStart(2, "0")}:00`);
  if (r.busiestDay) fun.push(`busiest day ${r.busiestDay}`);
  if (r.longestSession) fun.push(`longest session ${fmtDuration(r.longestSession.ms)}`);
  if (fun.length > 0) lines.push(`Fun  ${fun.join(" · ")}`);
  lines.push("");
  lines.push(
    `(gaps ≤5m count as prompting, 5–30m as away, >30m excluded; ` +
      `tokens are counts, not cost; all from your own captured sessions)`,
  );
  return lines.join("\n");
}
