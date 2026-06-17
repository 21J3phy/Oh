// Local-mode store (ADR 0013): the Team Brain as plain files under ~/.oh/local,
// never leaving the machine. Implements the same `Db` interface Supabase does,
// so capture/ask/insights are unchanged — they don't know the brain is local.
//
// Storage is deliberately boring and inspectable (enterprise reviewers can read
// it): newline-delimited JSON for the append-y tables, one JSON map for
// sessions. Vector search is brute-force cosine in memory — for one developer's
// sessions (thousands of chunks, a few MB of float arrays) this is instant, and
// it keeps the install free of native modules or a database engine.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LOCAL_DIR } from "../config.js";
import type {
  AskLogEntry,
  AskStats,
  Db,
  MatchFilters,
  MatchRow,
  MetricsRow,
} from "../db.js";
import { chunkId } from "../db.js";
import type { Exchange, SessionMeta, Tool } from "../types.js";

interface ChunkRow {
  id: string;
  session_id: string;
  author: string;
  tool: Tool;
  repo: string | null;
  cwd: string | null;
  exchange_index: number;
  text: string;
  ts: string;
  embedding: number[];
}

interface SessionRow {
  id: string;
  tool: Tool;
  author: string;
  repo: string | null;
  cwd: string | null;
  started_at: string;
  last_seen_at: string;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // a torn last line (crash mid-write) is skipped, not fatal
    }
  }
  return out;
}

function writeJsonl<T>(path: string, rows: T[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

/** Cosine similarity. Local embeddings are L2-normalized, so this is a dot
 *  product — but we normalize defensively in case a row predates that. */
function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Fuzzy keyword-search tuning. A term "matches" a word when their similarity
// clears the threshold; substring hits and typos (a bounded edit distance)
// both qualify, so "athu"/"authetication" still find "auth"/"authentication".
const FUZZY_THRESHOLD = 0.7;

/** Split text into distinct lowercased word tokens (≥2 chars). */
function tokenize(text: string): string[] {
  const seen = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 2) seen.add(t);
  }
  return [...seen];
}

/** Distinct query terms (≥2 chars) — short tokens match everything, so drop. */
function queryTerms(query: string): string[] {
  return tokenize(query);
}

/** Levenshtein edit distance, capped at `max`: bails to `max + 1` as soon as a
 *  whole row exceeds the cap, so far-apart strings stay cheap. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
      if (curr[j]! < rowMin) rowMin = curr[j]!;
    }
    if (rowMin > max) return max + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** How well a query term matches a single word (0..1): exact, substring, or a
 *  typo within a length-scaled edit budget — anything further apart is 0. */
function termSimilarity(term: string, word: string): number {
  if (term === word) return 1;
  // A query term appearing inside a word (e.g. "auth" in "authenticate") is a
  // strong match — this preserves the old plain-substring behaviour.
  if (word.includes(term)) return 0.9;
  if (term.includes(word)) return word.length / term.length;
  // Typo tolerance: ~1 edit for short terms, ~2 for longer ones.
  const max = term.length <= 4 ? 1 : 2;
  const d = editDistance(term, word, max);
  if (d > max) return 0;
  return 1 - d / Math.max(term.length, word.length);
}

/** Fuzzy overlap of query terms against `text` (0..1) — a similarity proxy in
 *  the same range as cosine, so `rerank`'s recency blend still works. Each term
 *  contributes its best per-word similarity once it clears the threshold. */
function fuzzyScore(terms: string[], text: string): number {
  const words = tokenize(text);
  let total = 0;
  for (const t of terms) {
    let best = 0;
    for (const w of words) {
      const s = termSimilarity(t, w);
      if (s > best) {
        best = s;
        if (best === 1) break;
      }
    }
    if (best >= FUZZY_THRESHOLD) total += best;
  }
  return total / terms.length;
}

/** A file-backed Team Brain that lives entirely on this machine. `dir` is
 *  injectable for tests; production uses ~/.oh/local. */
export function createLocalDb(dir: string = LOCAL_DIR): Db {
  const CHUNKS_PATH = join(dir, "chunks.jsonl");
  const SESSIONS_PATH = join(dir, "sessions.json");
  const METRICS_PATH = join(dir, "metrics.jsonl");
  const ASKS_PATH = join(dir, "asks.jsonl");
  const ensureLocalDir = (): void => {
    mkdirSync(dir, { recursive: true });
  };

  // Lazy in-memory caches, loaded once per process and mutated write-through.
  let chunks: ChunkRow[] | null = null;
  let metrics: MetricsRow[] | null = null;
  let sessions: Map<string, SessionRow> | null = null;

  const loadChunks = (): ChunkRow[] => (chunks ??= readJsonl<ChunkRow>(CHUNKS_PATH));
  const loadMetrics = (): MetricsRow[] => (metrics ??= readJsonl<MetricsRow>(METRICS_PATH));
  const loadSessions = (): Map<string, SessionRow> => {
    if (sessions) return sessions;
    sessions = new Map();
    if (existsSync(SESSIONS_PATH)) {
      try {
        const arr = JSON.parse(readFileSync(SESSIONS_PATH, "utf8")) as SessionRow[];
        for (const s of arr) sessions.set(s.id, s);
      } catch {
        /* start empty on a corrupt file rather than crash capture */
      }
    }
    return sessions;
  };

  const matchesFilters = (
    row: { author: string; repo: string | null; ts: string },
    filters: MatchFilters,
  ): boolean => {
    if (filters.repo && row.repo !== filters.repo) return false;
    if (filters.author) {
      // Supabase uses ILIKE '%name%'; mirror that as a case-insensitive substring.
      const needle = filters.author.replace(/%/g, "").toLowerCase();
      if (needle && !row.author.toLowerCase().includes(needle)) return false;
    }
    if (filters.since && row.ts < filters.since) return false;
    return true;
  };

  return {
    async upsertSession(s: SessionMeta): Promise<void> {
      const map = loadSessions();
      map.set(s.sessionId, {
        id: s.sessionId,
        tool: s.tool,
        author: s.author,
        repo: s.repo,
        cwd: s.cwd,
        started_at: s.startedAt,
        last_seen_at: s.lastSeenAt,
      });
      ensureLocalDir();
      writeFileSync(SESSIONS_PATH, JSON.stringify([...map.values()]));
    },

    async upsertChunks(exchanges: Exchange[], embeddings: number[][]): Promise<void> {
      if (exchanges.length === 0) return;
      if (exchanges.length !== embeddings.length) {
        throw new Error("upsertChunks: exchanges/embeddings length mismatch");
      }
      const rows = loadChunks();
      const byId = new Map(rows.map((r, i) => [r.id, i] as const));
      exchanges.forEach((ex, i) => {
        const row: ChunkRow = {
          id: chunkId(ex.sessionId, ex.index),
          session_id: ex.sessionId,
          author: ex.author,
          tool: ex.tool,
          repo: ex.repo,
          cwd: ex.cwd,
          exchange_index: ex.index,
          text: ex.reasoningText,
          ts: ex.ts,
          embedding: embeddings[i]!,
        };
        const at = byId.get(row.id);
        if (at === undefined) {
          byId.set(row.id, rows.length);
          rows.push(row);
        } else {
          rows[at] = row;
        }
      });
      writeJsonl(CHUNKS_PATH, rows);
    },

    async upsertMetrics(exchanges: Exchange[]): Promise<void> {
      if (exchanges.length === 0) return;
      const rows = loadMetrics();
      const byId = new Map(rows.map((r, i) => [r.id, i] as const));
      for (const ex of exchanges) {
        const row: MetricsRow = {
          id: chunkId(ex.sessionId, ex.index),
          session_id: ex.sessionId,
          author: ex.author,
          tool: ex.tool,
          repo: ex.repo,
          exchange_index: ex.index,
          ts: ex.ts,
          ended_at: ex.metrics.endedAt,
          think_ms: ex.metrics.thinkMs,
          work_ms: ex.metrics.workMs,
          input_tokens: ex.metrics.inputTokens,
          output_tokens: ex.metrics.outputTokens,
          cache_read_tokens: ex.metrics.cacheReadTokens,
          cache_write_tokens: ex.metrics.cacheWriteTokens,
          tool_calls: ex.metrics.toolCalls,
          file_reads: ex.metrics.fileReads,
          file_edits: ex.metrics.fileEdits,
          errors: ex.metrics.errors,
          interrupted: ex.metrics.interrupted,
          is_correction: ex.metrics.isCorrection,
          model: ex.metrics.model,
        };
        const at = byId.get(row.id);
        if (at === undefined) {
          byId.set(row.id, rows.length);
          rows.push(row);
        } else {
          rows[at] = row;
        }
      }
      writeJsonl(METRICS_PATH, rows);
    },

    async fetchMetrics(filters: MatchFilters): Promise<MetricsRow[]> {
      return loadMetrics()
        .filter((r) => matchesFilters(r, filters))
        .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : 1));
    },

    async logAsk(entry: AskLogEntry): Promise<void> {
      ensureLocalDir();
      const line =
        JSON.stringify({
          id: crypto.randomUUID(),
          author: entry.author,
          question: entry.question,
          repo_filter: entry.repoFilter,
          who_filter: entry.whoFilter,
          hits: entry.hits,
          top_similarity: entry.topSimilarity,
          ts: new Date().toISOString(),
        }) + "\n";
      // Append-only — asks are a running log, never updated.
      writeFileSync(ASKS_PATH, line, { flag: "a" });
    },

    async askStats(sinceIso: string): Promise<AskStats> {
      const rows = readJsonl<{ ts: string; hits: number }>(ASKS_PATH).filter((r) => r.ts >= sinceIso);
      return { total: rows.length, answered: rows.filter((r) => (r.hits ?? 0) > 0).length };
    },

    async latestChunk(author: string) {
      const needle = author.toLowerCase();
      let best: ChunkRow | null = null;
      for (const r of loadChunks()) {
        if (!r.author.toLowerCase().includes(needle)) continue;
        if (!best || r.ts > best.ts) best = r;
      }
      return best ? { text: best.text, repo: best.repo, ts: best.ts } : null;
    },

    async fetchOwnChunkTexts(author: string, sinceIso: string) {
      const needle = author.toLowerCase();
      return loadChunks()
        .filter((r) => r.author.toLowerCase().includes(needle) && r.ts >= sinceIso)
        .sort((a, b) => (a.ts < b.ts ? -1 : 1))
        .slice(0, 2000)
        .map((r) => ({ id: r.id, text: r.text }));
    },

    async matchChunks(
      embedding: number[],
      matchCount: number,
      filters: MatchFilters,
    ): Promise<MatchRow[]> {
      const scored: MatchRow[] = [];
      for (const r of loadChunks()) {
        if (!matchesFilters(r, filters)) continue;
        scored.push({
          id: r.id,
          session_id: r.session_id,
          author: r.author,
          tool: r.tool,
          repo: r.repo,
          cwd: r.cwd,
          exchange_index: r.exchange_index,
          text: r.text,
          ts: r.ts,
          similarity: cosine(embedding, r.embedding),
        });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, matchCount);
    },

    async keywordMatch(
      query: string,
      matchCount: number,
      filters: MatchFilters,
    ): Promise<MatchRow[]> {
      const terms = queryTerms(query);
      if (terms.length === 0) return [];
      const scored: MatchRow[] = [];
      for (const r of loadChunks()) {
        if (!matchesFilters(r, filters)) continue;
        const similarity = fuzzyScore(terms, r.text);
        if (similarity === 0) continue;
        scored.push({
          id: r.id,
          session_id: r.session_id,
          author: r.author,
          tool: r.tool,
          repo: r.repo,
          cwd: r.cwd,
          exchange_index: r.exchange_index,
          text: r.text,
          ts: r.ts,
          similarity,
        });
      }
      scored.sort((a, b) => b.similarity - a.similarity);
      return scored.slice(0, matchCount);
    },

    async chunkCount(): Promise<number> {
      return loadChunks().length;
    },
  };
}
