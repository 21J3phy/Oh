// The `ask` core: embed the question, pull top-N candidates from the Team
// Brain, then re-rank by similarity + a recency boost so a later Session that
// reversed an earlier decision wins on conflict. Pure functions are exported
// for testing; `ask()` wires them to the DB + embedder.

import type { AskHit, Config } from "./types.js";
import type { Db, MatchFilters, MatchRow } from "./db.js";
import type { Embedder } from "./embed.js";
import { scrubText } from "./scrub.js";
import { log } from "./log.js";

const CANDIDATES = 30;
const TOP_K = 8;
const SNIPPET_CHARS = 800;

export interface AskParams {
  question: string;
  who?: string;
  repo?: string;
  since?: string;
}

export interface AskResult {
  hits: AskHit[];
  mostRecent: string | null;
}

/** Parse `since` as an ISO date or a relative window like "7d"/"24h"/"2w"/"3m". */
export function parseSince(s?: string): string | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const rel = trimmed.match(/^(\d+)\s*([hdwm])$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms =
      unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : unit === "w" ? 604_800_000 : 2_592_000_000;
    return new Date(Date.now() - n * ms).toISOString();
  }
  const t = Date.parse(trimmed);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/** Exponential decay: 1.0 at age 0, 0.5 at one half-life. */
export function recencyScore(tsMs: number, nowMs: number, halfLifeDays: number): number {
  const ageDays = Math.max(0, (nowMs - tsMs) / 86_400_000);
  return Math.pow(2, -ageDays / Math.max(0.001, halfLifeDays));
}

/** Re-rank candidate rows by similarity + λ·recency (descending). */
export function rerank(rows: MatchRow[], cfg: Config, nowMs: number): AskHit[] {
  return rows
    .map((r): AskHit => {
      const tsMs = Date.parse(r.ts);
      const recency = Number.isNaN(tsMs) ? 0 : recencyScore(tsMs, nowMs, cfg.recencyHalfLifeDays);
      return {
        text: r.text,
        who: r.author,
        tool: r.tool,
        repo: r.repo,
        sessionId: r.session_id,
        ts: r.ts,
        similarity: r.similarity,
        score: r.similarity + cfg.recencyWeight * recency,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export async function ask(
  cfg: Config,
  db: Db,
  embedder: Embedder,
  params: AskParams,
): Promise<AskResult> {
  const question = params.question?.trim();
  if (!question) return { hits: [], mostRecent: null };

  const embedding = await embedder.embedOne(question);
  const filters: MatchFilters = {
    repo: params.repo?.trim() || null,
    author: params.who?.trim() ? `%${params.who.trim()}%` : null,
    since: parseSince(params.since),
  };
  const rows = await db.matchChunks(embedding, CANDIDATES, filters);
  const hits = rerank(rows, cfg, Date.now()).slice(0, TOP_K);

  // Deflection instrumentation (ADR 0008): every ask is logged; an answered
  // ask is an interruption Oh absorbed. Must never break the answer itself.
  void db
    .logAsk({
      author: cfg.author,
      question: scrubText(question),
      repoFilter: filters.repo ?? null,
      whoFilter: params.who?.trim() ? params.who.trim() : null,
      hits: hits.length,
      topSimilarity: hits.length > 0 ? hits[0]!.similarity : null,
    })
    .catch((err) => log("ask", `logAsk failed (apply migrations/0003_asks.sql?) — ${(err as Error).message}`));

  let mostRecentMs: number | null = null;
  for (const h of hits) {
    const t = Date.parse(h.ts);
    if (!Number.isNaN(t) && (mostRecentMs === null || t > mostRecentMs)) mostRecentMs = t;
  }
  return {
    hits,
    mostRecent: mostRecentMs === null ? null : new Date(mostRecentMs).toISOString(),
  };
}

/** Render an AskResult as the cited text block the calling agent synthesizes from. */
export function formatAskResult(result: AskResult): string {
  if (result.hits.length === 0) {
    return "No relevant context found in the team's shared memory.";
  }
  const lines: string[] = [];
  if (result.mostRecent) lines.push(`Most recent relevant context: ${result.mostRecent}`);
  result.hits.forEach((h, i) => {
    const sid = h.sessionId.length > 8 ? `${h.sessionId.slice(0, 8)}…` : h.sessionId;
    const snippet = h.text.length > SNIPPET_CHARS ? h.text.slice(0, SNIPPET_CHARS) + "…" : h.text;
    lines.push(
      "",
      `[${i + 1}] ${h.who} · ${h.tool} · ${h.repo ?? "?"} · ${h.ts} · session ${sid} (sim ${h.similarity.toFixed(2)})`,
      snippet,
    );
  });
  return lines.join("\n");
}
