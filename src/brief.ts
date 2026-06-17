// The session-start brief: Insights' ambient surface (people forget to run
// `oh insights`). The detached capture refreshes a small local cache after
// every sweep; the SessionStart hook renders it in two lines with zero network
// and zero blocking. Self-only by construction — the cache holds only the
// configured author's numbers (ADR 0008).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  BRIEF_MARKER_PATH,
  BRIEF_TIP_INDEX_PATH,
  DAILY_HISTORY_PATH,
  INSIGHTS_CACHE_PATH,
  LAST_SESSION_PATH,
  ensureDirs,
} from "./config.js";
import { computeInsights, generateTips, type InsightsReport } from "./insights.js";
import { shortRepo } from "./normalize.js";
import type { Db, MetricsRow } from "./db.js";
import type { Config, Tool } from "./types.js";

/** Don't render a cache older than this — better silence than stale numbers. */
const CACHE_MAX_AGE_MS = 26 * 3_600_000;

/**
 * Everything `formatBrief` needs to render one brief — either the all-repos
 * rollup (the cache's top-level fields) or a single repo's slice (a `byRepo`
 * entry). Kept as its own shape so the same renderer serves both.
 */
export interface BriefData {
  day: InsightsReport; // last 24h
  week: InsightsReport; // last 7d
  /** What you were last working on — the tool's own session summary when available. */
  last?: { snippet: string; repo: string | null; ts: string } | null;
  /**
   * Grounded tip drafts, best first — each carries the real quote/numbers the
   * mechanical layer found (generateTips). The SessionStart hook hands one to
   * the user's own running agent to personalize at render, so Oh makes no LLM
   * call of its own (works the same in hosted, keyless mode). Shown as-is if the
   * agent doesn't rewrite it.
   */
  tips?: string[];
}

export interface InsightsCache extends BriefData {
  updatedAt: string;
  author: string;
  /**
   * Per-repo brief slices, keyed by the same git-repo identity stored on each
   * row (`gitRepoIdentity`). The SessionStart hook picks the entry for the repo
   * the session is starting in, so insights never bleed across projects; a repo
   * with no captured history is simply absent (no brief). Top-level day/week/
   * tips remain the all-repos rollup, used when repoScopedBrief is off.
   */
  byRepo?: Record<string, BriefData>;
}

/** ~/.oh/last-session.json — written by capture, newest session wins per repo. */
export interface LastSession {
  summary: string;
  repo: string | null;
  ts: string;
}

/** The on-disk shape of last-session.json: newest session per git-repo identity. */
export type LastSessionMap = Record<string, LastSession>;

/**
 * Read last-session.json as a per-repo map, tolerating the legacy single-entry
 * shape ({summary, repo, ts}) written before per-repo tracking existed.
 */
export function readLastSessionMap(): LastSessionMap {
  if (!existsSync(LAST_SESSION_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(LAST_SESSION_PATH, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    // Legacy: a bare LastSession (has a top-level string `summary`).
    if (typeof (raw as LastSession).summary === "string") {
      const ls = raw as LastSession;
      return { [ls.repo ?? "unknown"]: ls };
    }
    return raw as LastSessionMap;
  } catch {
    return {};
  }
}

/** One frozen day in ~/.oh/insights-daily.json (compact subset of a report). */
export interface DailyStat {
  date: string; // local YYYY-MM-DD
  promptMs: number;
  awayMs: number;
  workMs: number;
  exchanges: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  /**
   * Fresh tokens (input + output + cacheWrite) split by the agent that spent
   * them — claude / codex / copilot. Optional: days frozen before this field
   * existed won't carry it, so readers must tolerate its absence.
   */
  byTool?: Partial<Record<Tool, number>>;
}

/** Map of local YYYY-MM-DD → that day's totals (the on-disk shape). */
export type DailyHistory = Record<string, DailyStat>;

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function readRawDailyHistory(): DailyHistory {
  if (!existsSync(DAILY_HISTORY_PATH)) return {};
  try {
    return JSON.parse(readFileSync(DAILY_HISTORY_PATH, "utf8")) as DailyHistory;
  } catch {
    return {};
  }
}

/** Past days first → today last. The public read for `oh insights --history`. */
export function readDailyHistory(): DailyStat[] {
  return Object.values(readRawDailyHistory()).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Bucket the fetched rows by local calendar day and merge each day's totals into
 * the on-disk history. Upsert (not append): re-running over the same window just
 * rewrites those days, so frequent refreshes are idempotent and self-healing.
 */
function persistDailyHistory(rows: MetricsRow[], author: string): void {
  const history = readRawDailyHistory();
  const byDay = new Map<string, MetricsRow[]>();
  for (const r of rows) {
    const t = Date.parse(r.ts);
    if (Number.isNaN(t)) continue;
    const key = localDayKey(t);
    const list = byDay.get(key);
    if (list) list.push(r);
    else byDay.set(key, [r]);
  }
  for (const [date, dayRows] of byDay) {
    const rep = computeInsights(dayRows, { author });
    const byTool: Partial<Record<Tool, number>> = {};
    for (const r of dayRows) {
      byTool[r.tool] = (byTool[r.tool] ?? 0) + r.input_tokens + r.output_tokens + r.cache_write_tokens;
    }
    history[date] = {
      date,
      promptMs: rep.promptMs,
      awayMs: rep.awayMs,
      workMs: rep.workMs,
      exchanges: rep.exchanges,
      sessions: rep.sessions,
      inputTokens: rep.inputTokens,
      outputTokens: rep.outputTokens,
      cacheWriteTokens: rep.cacheWriteTokens,
      byTool,
    };
  }
  ensureDirs();
  writeFileSync(DAILY_HISTORY_PATH, JSON.stringify(history));
}

/** "fix the hosted invite codes…" from a chunk's "User: …" first line. */
export function lastSnippet(chunkText: string): string {
  const firstLine = (chunkText.split("\n")[0] ?? "").replace(/^User:\s*/, "").trim();
  return firstLine.length > 90 ? `${firstLine.slice(0, 89)}…` : firstLine;
}

/**
 * Recompute the cache from the Team Brain. Called from `oh capture` (the
 * detached post-turn process), so its latency and failures never touch a turn;
 * callers swallow errors (offline is fine — the brief just goes quiet).
 */
export async function refreshInsightsCache(cfg: Config, db: Db): Promise<void> {
  const now = Date.now();
  const weekIso = new Date(now - 7 * 86_400_000).toISOString();
  // "Today" means the local calendar day — resets at local midnight, not a
  // rolling 24h lookback (else last night's session bleeds into this morning).
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayIso = dayStart.toISOString();
  const rows = await db.fetchMetrics({ author: cfg.author, since: weekIso });
  // Freeze each day's totals to disk before the day rolls over (the cache only
  // ever holds today + this week). Recomputing the fetched window self-heals
  // gaps; days that age out of the window stay as last written.
  persistDailyHistory(rows, cfg.author);
  // Captured prompt text, keyed by chunk id — the raw material for both the
  // grounded tips and the per-repo "where you left off" fallback. Empty on an
  // insights-only install (nothing is stored), which is fine: the brief just
  // drops to its stat line.
  let textsById = new Map<string, string>();
  try {
    const texts = await db.fetchOwnChunkTexts(cfg.author, weekIso);
    textsById = new Map(texts.map((t) => [t.id, t.text]));
  } catch {
    // optional decoration — never block the cache on it
  }
  const lastMap = readLastSessionMap();
  // "Last on" (all-repos rollup): prefer the newest recorded session summary;
  // fall back to the newest chunk's opening prompt from the store.
  let last: InsightsCache["last"] = null;
  try {
    const newest = Object.values(lastMap)
      .filter((ls) => ls.summary)
      .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0];
    if (newest) last = { snippet: newest.summary, repo: newest.repo, ts: newest.ts };
    if (!last) {
      const chunk = await db.latestChunk(cfg.author);
      if (chunk) last = { snippet: lastSnippet(chunk.text), repo: chunk.repo, ts: chunk.ts };
    }
  } catch {
    // optional decoration — never block the cache on it
  }
  // Mechanically-grounded drafts — the real moments + verbatim quotes. The hook
  // hands one to the user's own agent to personalize (see InsightsCache). Keep
  // the full ranked set so the brief can rotate through them.
  const tipsFrom = (rs: MetricsRow[]): string[] => {
    try {
      return generateTips(rs, [...textsById].map(([id, text]) => ({ id, text }))).map((t) => t.text);
    } catch {
      return [];
    }
  };
  const dayRows = rows.filter((r) => r.ts >= dayIso);

  // Per-repo slices — the repo-scoped brief reads exactly one of these so a
  // session never sees another project's numbers (or any, on an untracked repo).
  const byRepo: Record<string, BriefData> = {};
  for (const repo of new Set(rows.map((r) => r.repo ?? "unknown"))) {
    const repoWeek = rows.filter((r) => (r.repo ?? "unknown") === repo);
    const repoDay = dayRows.filter((r) => (r.repo ?? "unknown") === repo);
    byRepo[repo] = {
      day: computeInsights(repoDay, { author: cfg.author, sinceIso: dayIso }),
      week: computeInsights(repoWeek, { author: cfg.author, sinceIso: weekIso }),
      last: repoLast(repo, repoWeek, textsById, lastMap),
      tips: tipsFrom(repoWeek),
    };
  }

  const cache: InsightsCache = {
    updatedAt: new Date(now).toISOString(),
    author: cfg.author,
    day: computeInsights(dayRows, { author: cfg.author, sinceIso: dayIso }),
    week: computeInsights(rows, { author: cfg.author, sinceIso: weekIso }),
    last,
    tips: tipsFrom(rows),
    byRepo,
  };
  ensureDirs();
  writeFileSync(INSIGHTS_CACHE_PATH, JSON.stringify(cache));
}

/** This repo's "where you left off": its recorded summary, else its newest captured prompt. */
function repoLast(
  repo: string,
  repoRows: MetricsRow[],
  textsById: Map<string, string>,
  lastMap: LastSessionMap,
): InsightsCache["last"] {
  const rec = lastMap[repo];
  if (rec?.summary) return { snippet: rec.summary, repo: rec.repo, ts: rec.ts };
  let newest: MetricsRow | null = null;
  for (const r of repoRows) if (!newest || r.ts > newest.ts) newest = r;
  if (newest) {
    const text = textsById.get(newest.id);
    if (text) return { snippet: lastSnippet(text), repo, ts: newest.ts };
  }
  return null;
}

/**
 * Pick the brief to render for a session starting in `repo`. When scoped (the
 * default), returns that repo's slice — or null if the repo has no captured
 * history (an untracked project gets no brief). When unscoped, returns the
 * all-repos rollup.
 */
export function pickRepoBrief(
  cache: InsightsCache,
  repo: string | null,
  scoped: boolean,
): BriefData | null {
  if (!scoped) return cache;
  if (!repo) return null;
  return cache.byRepo?.[repo] ?? null;
}

export function readInsightsCache(nowMs: number): InsightsCache | null {
  if (!existsSync(INSIGHTS_CACHE_PATH)) return null;
  try {
    const cache = JSON.parse(readFileSync(INSIGHTS_CACHE_PATH, "utf8")) as InsightsCache;
    const age = nowMs - Date.parse(cache.updatedAt);
    if (Number.isNaN(age) || age < 0 || age > CACHE_MAX_AGE_MS) return null;
    return cache;
  } catch {
    return null;
  }
}

function sameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Cadence gate. Default "session" = every new session; "daily" = first of the local day. */
export function shouldShowBrief(
  cadence: Config["brief"],
  lastShownMs: number | null,
  nowMs: number,
): boolean {
  if (cadence === "off") return false;
  if (cadence === "daily") return lastShownMs == null || !sameLocalDay(lastShownMs, nowMs);
  return true; // "session" (default)
}

export function readBriefMarker(): number | null {
  if (!existsSync(BRIEF_MARKER_PATH)) return null;
  const t = Date.parse(readFileSync(BRIEF_MARKER_PATH, "utf8").trim());
  return Number.isNaN(t) ? null : t;
}

export function writeBriefMarker(nowMs: number): void {
  ensureDirs();
  writeFileSync(BRIEF_MARKER_PATH, new Date(nowMs).toISOString());
}

/**
 * A monotonically-advancing counter used to pick which tip the brief shows.
 * Bumped once per actual brief render (not per day) so each session surfaces a
 * different tip instead of repeating the same one all day.
 */
export function readTipRotation(): number {
  if (!existsSync(BRIEF_TIP_INDEX_PATH)) return 0;
  const n = Number.parseInt(readFileSync(BRIEF_TIP_INDEX_PATH, "utf8").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function writeTipRotation(n: number): void {
  ensureDirs();
  writeFileSync(BRIEF_TIP_INDEX_PATH, String(n));
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

function ago(tsIso: string, nowMs: number): string {
  const mins = Math.round((nowMs - Date.parse(tsIso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 0) return "";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 24 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / (24 * 60))}d ago`;
}

/**
 * Stacked token bars, one per day, split by the agent that spent them. Each
 * agent owns a distinct block glyph; the bar is scaled so the busiest day fills
 * BAR cols. Days frozen before `byTool` existed have no split — their tokens
 * render as a faint "untracked" fill so the row still reads. Returns "" when no
 * day carries token data (nothing to chart).
 */
const TOKEN_BAR_WIDTH = 22;
const TOOL_GLYPHS: Array<{ tool: Tool; glyph: string }> = [
  { tool: "claude", glyph: "█" },
  { tool: "codex", glyph: "▓" },
  { tool: "copilot", glyph: "▒" },
];
const UNTRACKED_GLYPH = "░";

function freshOf(s: DailyStat): number {
  return s.inputTokens + s.outputTokens + s.cacheWriteTokens;
}

/** Floor each segment proportionally, then hand leftover cols to the largest fractions. */
function stackBar(perTool: Partial<Record<Tool, number>>, total: number, barLen: number): string {
  if (barLen <= 0 || total <= 0) return "";
  const raw = TOOL_GLYPHS.map((g) => ((perTool[g.tool] ?? 0) / total) * barLen);
  const cols = raw.map(Math.floor);
  let used = cols.reduce((a, b) => a + b, 0);
  const byFrac = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byFrac) {
    if (used >= barLen) break;
    if ((perTool[TOOL_GLYPHS[i]!.tool] ?? 0) > 0) {
      cols[i]!++;
      used++;
    }
  }
  return TOOL_GLYPHS.map((g, i) => g.glyph.repeat(cols[i]!)).join("");
}

export function formatTokenChart(days: DailyStat[]): string {
  const maxFresh = Math.max(0, ...days.map(freshOf));
  if (maxFresh === 0) return "";
  const usedTools = new Set<Tool>();
  for (const s of days) {
    for (const g of TOOL_GLYPHS) if ((s.byTool?.[g.tool] ?? 0) > 0) usedTools.add(g.tool);
  }
  let anyUntracked = false;
  const legend = TOOL_GLYPHS.filter((g) => usedTools.has(g.tool))
    .map((g) => `${g.glyph} ${g.tool}`)
    .join("  ");
  const lines = [`Tokens by agent  (${legend})`];
  for (const s of days) {
    const fresh = freshOf(s);
    const barLen = Math.round((fresh / maxFresh) * TOKEN_BAR_WIDTH);
    let bar: string;
    if (s.byTool && Object.keys(s.byTool).length > 0) {
      const total = TOOL_GLYPHS.reduce((sum, g) => sum + (s.byTool![g.tool] ?? 0), 0);
      bar = stackBar(s.byTool, total, barLen);
    } else {
      // No per-agent split recorded for this day — show its size, not its makeup.
      bar = UNTRACKED_GLYPH.repeat(barLen);
      if (fresh > 0) anyUntracked = true;
    }
    lines.push(`${s.date.padEnd(12)} ${bar.padEnd(TOKEN_BAR_WIDTH)} ${fmtTokens(fresh).padStart(7)}`);
  }
  if (anyUntracked) lines.push(`(${UNTRACKED_GLYPH} = older days, recorded before the per-agent split)`);
  return lines.join("\n");
}

/** A right-aligned day-by-day table for `oh insights --history`. */
export function formatDailyHistory(limit?: number): string {
  const all = readDailyHistory();
  if (all.length === 0) return "No daily history yet — it builds up as you work.";
  const days = limit && limit > 0 ? all.slice(-limit) : all;
  const pad = (s: string, n: number) => s.padEnd(n);
  const r = (s: string, n: number) => s.padStart(n);
  const lines = [`${pad("date", 12)} ${r("total", 8)} ${r("you", 7)} ${r("agent", 7)} ${r("sess", 5)} ${r("tok", 7)}`];
  let pMs = 0;
  let wMs = 0;
  let aMs = 0;
  let sess = 0;
  let tok = 0;
  for (const s of days) {
    const wall = s.promptMs + s.awayMs + s.workMs;
    const fresh = s.inputTokens + s.outputTokens + s.cacheWriteTokens;
    pMs += s.promptMs;
    wMs += s.workMs;
    aMs += wall;
    sess += s.sessions;
    tok += fresh;
    lines.push(
      `${pad(s.date, 12)} ${r(fmtDuration(wall), 8)} ${r(fmtDuration(s.promptMs), 7)} ${r(fmtDuration(s.workMs), 7)} ${r(String(s.sessions), 5)} ${r(fmtTokens(fresh), 7)}`,
    );
  }
  lines.push(
    `${pad("total", 12)} ${r(fmtDuration(aMs), 8)} ${r(fmtDuration(pMs), 7)} ${r(fmtDuration(wMs), 7)} ${r(String(sess), 5)} ${r(fmtTokens(tok), 7)}`,
  );
  const chart = formatTokenChart(days);
  if (chart) lines.push("", chart);
  return lines.join("\n");
}

/**
 * One unified block, branded exactly once:
 *
 *   Oh ▸ where you left off: "…" (repo · 2h ago)
 *     today 3h 27m (1h 5m you · 2h 3m agent) · 3.0M tokens — week: 8 sessions
 *     tip: that "ok i think it worked…" ask (Fri 19:47) cost 418k tokens …
 *
 * Null = nothing worth saying (don't show an empty brief).
 */
export function formatBrief(
  cache: BriefData,
  nowMs: number = Date.now(),
  rotation?: number,
): string | null {
  const d = cache.day;
  const w = cache.week;
  if (w.exchanges === 0) return null;

  const statBits: string[] = [];
  if (d.exchanges > 0) {
    const wall = d.promptMs + d.awayMs + d.workMs;
    const fresh = d.inputTokens + d.outputTokens + d.cacheWriteTokens;
    statBits.push(
      `today ${fmtDuration(wall)} (${fmtDuration(d.promptMs)} you · ${fmtDuration(d.workMs)} agent) · ${fmtTokens(fresh)} tokens` +
        (d.rabbitHoleEpisodes > 0 ? ` · ${d.rabbitHoleEpisodes} rabbit hole${d.rabbitHoleEpisodes === 1 ? "" : "s"}` : ""),
    );
  }
  const weekWall = w.promptMs + w.awayMs + w.workMs;
  statBits.push(
    `week: ${fmtDuration(weekWall)}, ${w.sessions} session${w.sessions === 1 ? "" : "s"}` +
      (w.rabbitHoleEpisodes > 0 && d.rabbitHoleEpisodes !== w.rabbitHoleEpisodes
        ? `, ${w.rabbitHoleEpisodes} rabbit hole${w.rabbitHoleEpisodes === 1 ? "" : "s"}`
        : ""),
  );
  const statLine = statBits.join(" — ");

  const lines: string[] = [];
  if (cache.last?.snippet) {
    const where = [cache.last.repo, ago(cache.last.ts, nowMs)].filter(Boolean).join(" · ");
    lines.push(`Oh ▸ where you left off: "${cache.last.snippet}"${where ? ` (${where})` : ""}`);
    lines.push(`  ${statLine}`);
  } else {
    lines.push(`Oh ▸ ${statLine}`);
  }
  // When today's work spanned more than one repo, show the split — the daily
  // total above is the sum (`byRepo` may be absent in a pre-upgrade cache).
  const dayRepos = d.byRepo ?? [];
  if (d.exchanges > 0 && dayRepos.length >= 2) {
    const bits = dayRepos
      .slice(0, 3)
      .map((b) => `${shortRepo(b.repo)} ${fmtDuration(b.promptMs + b.awayMs + b.workMs)}`);
    if (dayRepos.length > 3) bits.push(`+${dayRepos.length - 3} more`);
    lines.push(`  by repo: ${bits.join(" · ")}`);
  }
  if (cache.tips && cache.tips.length > 0) {
    // Feature a different grounded draft each render (rotation, advanced per
    // brief by the caller); the hook asks the user's agent to personalize it.
    // Fall back to a daily rotation when no counter is supplied.
    const idx = rotation ?? Math.floor(nowMs / 86_400_000);
    lines.push(`  tip: ${cache.tips[idx % cache.tips.length]}`);
  }
  return lines.join("\n");
}
