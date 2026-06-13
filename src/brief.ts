// The session-start brief: Insights' ambient surface (people forget to run
// `oh insights`). The detached capture refreshes a small local cache after
// every sweep; the SessionStart hook renders it in two lines with zero network
// and zero blocking. Self-only by construction — the cache holds only the
// configured author's numbers (ADR 0008).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { BRIEF_MARKER_PATH, INSIGHTS_CACHE_PATH, LAST_SESSION_PATH, ensureDirs } from "./config.js";
import { computeInsights, generateTips, type InsightsReport } from "./insights.js";
import type { Db } from "./db.js";
import type { Config } from "./types.js";

/** Don't render a cache older than this — better silence than stale numbers. */
const CACHE_MAX_AGE_MS = 26 * 3_600_000;

export interface InsightsCache {
  updatedAt: string;
  author: string;
  day: InsightsReport; // last 24h
  week: InsightsReport; // last 7d
  /** What you were last working on — the tool's own session summary when available. */
  last?: { snippet: string; repo: string | null; ts: string } | null;
  /** Oh Tips for the week, best first (rule-based — see generateTips). */
  tips?: string[];
}

/** ~/.oh/last-session.json — written by capture (newest session wins). */
export interface LastSession {
  summary: string;
  repo: string | null;
  ts: string;
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
  const dayIso = new Date(now - 86_400_000).toISOString();
  const rows = await db.fetchMetrics({ author: cfg.author, since: weekIso });
  // "Last on": prefer the local last-session record (carries the tool's own
  // summary); fall back to the newest chunk's opening prompt from the store.
  let last: InsightsCache["last"] = null;
  try {
    if (existsSync(LAST_SESSION_PATH)) {
      const ls = JSON.parse(readFileSync(LAST_SESSION_PATH, "utf8")) as LastSession;
      if (ls.summary) last = { snippet: ls.summary, repo: ls.repo, ts: ls.ts };
    }
    if (!last) {
      const chunk = await db.latestChunk(cfg.author);
      if (chunk) last = { snippet: lastSnippet(chunk.text), repo: chunk.repo, ts: chunk.ts };
    }
  } catch {
    // optional decoration — never block the cache on it
  }
  let tips: string[] = [];
  try {
    const texts = await db.fetchOwnChunkTexts(cfg.author, weekIso);
    tips = generateTips(rows, texts).slice(0, 3).map((t) => t.text);
  } catch {
    // optional decoration — never block the cache on it
  }
  const cache: InsightsCache = {
    updatedAt: new Date(now).toISOString(),
    author: cfg.author,
    day: computeInsights(rows.filter((r) => r.ts >= dayIso), { author: cfg.author, sinceIso: dayIso }),
    week: computeInsights(rows, { author: cfg.author, sinceIso: weekIso }),
    last,
    tips,
  };
  ensureDirs();
  writeFileSync(INSIGHTS_CACHE_PATH, JSON.stringify(cache));
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

/** Three lines max. Null = nothing worth saying (don't show an empty brief). */
export function formatBrief(cache: InsightsCache, nowMs: number = Date.parse(cache.updatedAt)): string | null {
  const d = cache.day;
  const w = cache.week;
  if (w.exchanges === 0) return null;

  const lines: string[] = [];
  if (cache.last?.snippet) {
    const where = [cache.last.repo, ago(cache.last.ts, nowMs)].filter(Boolean).join(" · ");
    lines.push(`Last on: "${cache.last.snippet}"${where ? ` (${where})` : ""}`);
  }
  if (d.exchanges > 0) {
    const wall = d.promptMs + d.awayMs + d.workMs;
    const fresh = d.inputTokens + d.outputTokens + d.cacheWriteTokens;
    const parts = [
      `${fmtDuration(wall)} vibecoding (${fmtDuration(d.promptMs)} you · ${fmtDuration(d.workMs)} agent)`,
      `${fmtTokens(fresh)} fresh tokens`,
    ];
    if (d.rabbitHoleEpisodes > 0) {
      parts.push(`${d.rabbitHoleEpisodes} rabbit hole${d.rabbitHoleEpisodes === 1 ? "" : "s"}`);
    }
    lines.push(`Oh — last 24h: ${parts.join(" · ")}.`);
  }
  const weekWall = w.promptMs + w.awayMs + w.workMs;
  lines.push(
    `Week: ${fmtDuration(weekWall)} across ${w.sessions} session${w.sessions === 1 ? "" : "s"}` +
      (w.rabbitHoleEpisodes > 0 ? `, ${w.rabbitHoleEpisodes} rabbit hole${w.rabbitHoleEpisodes === 1 ? "" : "s"}` : "") +
      `. \`oh insights\` for detail.`,
  );
  if (cache.tips && cache.tips.length > 0) {
    lines.push(`Oh tip: ${cache.tips[0]}`);
  }
  return lines.join("\n");
}
