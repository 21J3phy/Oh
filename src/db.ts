// Supabase data access — the shared Team Brain. v0 talks to Postgres directly
// (no backend) using the service-role key from config.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config, Exchange, SessionMeta, Tool } from "./types.js";

const UPSERT_BATCH = 200;

/** A row returned by the match_chunks RPC, before recency re-ranking. */
export interface MatchRow {
  id: string;
  session_id: string;
  author: string;
  tool: Tool;
  repo: string | null;
  cwd: string | null;
  exchange_index: number;
  text: string;
  ts: string;
  similarity: number;
}

export interface MatchFilters {
  repo?: string | null;
  author?: string | null;
  since?: string | null;
}

/** A row in exchange_metrics — capture-time Metrics for the Insights view. */
export interface MetricsRow {
  id: string;
  session_id: string;
  author: string;
  tool: Tool;
  repo: string | null;
  exchange_index: number;
  ts: string;
  ended_at: string;
  think_ms: number | null;
  work_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_calls: number;
  file_reads: number;
  file_edits: number;
  errors: number;
  interrupted: boolean;
  is_correction: boolean;
  model: string | null;
}

export function chunkId(sessionId: string, exchangeIndex: number): string {
  return `${sessionId}:${exchangeIndex}`;
}

/** One logged ask — an answered ask is a deflected interruption (ADR 0008). */
export interface AskLogEntry {
  author: string;
  question: string;
  repoFilter: string | null;
  whoFilter: string | null;
  hits: number;
  topSimilarity: number | null;
}

export interface AskStats {
  total: number;
  answered: number;
}

export interface Db {
  raw: SupabaseClient;
  upsertSession(s: SessionMeta): Promise<void>;
  upsertChunks(exchanges: Exchange[], embeddings: number[][]): Promise<void>;
  upsertMetrics(exchanges: Exchange[]): Promise<void>;
  fetchMetrics(filters: MatchFilters): Promise<MetricsRow[]>;
  logAsk(entry: AskLogEntry): Promise<void>;
  askStats(sinceIso: string): Promise<AskStats>;
  matchChunks(
    embedding: number[],
    matchCount: number,
    filters: MatchFilters,
  ): Promise<MatchRow[]>;
  chunkCount(): Promise<number>;
}

export function createDb(cfg: Config): Db {
  const sb = createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return {
    raw: sb,

    async upsertSession(s: SessionMeta): Promise<void> {
      const { error } = await sb.from("sessions").upsert(
        {
          id: s.sessionId,
          tool: s.tool,
          author: s.author,
          repo: s.repo,
          cwd: s.cwd,
          started_at: s.startedAt,
          last_seen_at: s.lastSeenAt,
        },
        { onConflict: "id" },
      );
      if (error) throw new Error(`upsertSession failed: ${error.message}`);
    },

    async upsertChunks(exchanges: Exchange[], embeddings: number[][]): Promise<void> {
      if (exchanges.length === 0) return;
      if (exchanges.length !== embeddings.length) {
        throw new Error("upsertChunks: exchanges/embeddings length mismatch");
      }
      const rows = exchanges.map((ex, i) => ({
        id: chunkId(ex.sessionId, ex.index),
        session_id: ex.sessionId,
        author: ex.author,
        tool: ex.tool,
        repo: ex.repo,
        cwd: ex.cwd,
        exchange_index: ex.index,
        text: ex.reasoningText,
        ts: ex.ts,
        // pgvector accepts its text form '[1,2,...]', which is exactly JSON.
        embedding: JSON.stringify(embeddings[i]),
      }));
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH);
        const { error } = await sb.from("chunks").upsert(batch, { onConflict: "id" });
        if (error) throw new Error(`upsertChunks failed: ${error.message}`);
      }
    },

    async upsertMetrics(exchanges: Exchange[]): Promise<void> {
      if (exchanges.length === 0) return;
      const rows = exchanges.map((ex) => ({
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
      }));
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH);
        const { error } = await sb.from("exchange_metrics").upsert(batch, { onConflict: "id" });
        if (error) throw new Error(`upsertMetrics failed: ${error.message}`);
      }
    },

    async fetchMetrics(filters: MatchFilters): Promise<MetricsRow[]> {
      const PAGE = 1000; // Supabase caps a select at 1000 rows
      const out: MetricsRow[] = [];
      for (let from = 0; ; from += PAGE) {
        let q = sb
          .from("exchange_metrics")
          .select("*")
          .order("ts", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + PAGE - 1);
        if (filters.author) q = q.ilike("author", filters.author);
        if (filters.repo) q = q.eq("repo", filters.repo);
        if (filters.since) q = q.gte("ts", filters.since);
        const { data, error } = await q;
        if (error) throw new Error(`fetchMetrics failed: ${error.message}`);
        const rows = (data ?? []) as MetricsRow[];
        out.push(...rows);
        if (rows.length < PAGE) return out;
      }
    },

    async logAsk(entry: AskLogEntry): Promise<void> {
      const { error } = await sb.from("asks").insert({
        id: crypto.randomUUID(),
        author: entry.author,
        question: entry.question,
        repo_filter: entry.repoFilter,
        who_filter: entry.whoFilter,
        hits: entry.hits,
        top_similarity: entry.topSimilarity,
        ts: new Date().toISOString(),
      });
      if (error) throw new Error(`logAsk failed: ${error.message}`);
    },

    async askStats(sinceIso: string): Promise<AskStats> {
      const [total, answered] = await Promise.all([
        sb.from("asks").select("id", { count: "exact", head: true }).gte("ts", sinceIso),
        sb.from("asks").select("id", { count: "exact", head: true }).gte("ts", sinceIso).gt("hits", 0),
      ]);
      if (total.error) throw new Error(`askStats failed: ${total.error.message}`);
      if (answered.error) throw new Error(`askStats failed: ${answered.error.message}`);
      return { total: total.count ?? 0, answered: answered.count ?? 0 };
    },

    async matchChunks(
      embedding: number[],
      matchCount: number,
      filters: MatchFilters,
    ): Promise<MatchRow[]> {
      const { data, error } = await sb.rpc("match_chunks", {
        query_embedding: embedding,
        match_count: matchCount,
        p_repo: filters.repo ?? null,
        p_author: filters.author ?? null,
        p_since: filters.since ?? null,
      });
      if (error) throw new Error(`match_chunks failed: ${error.message}`);
      return (data ?? []) as MatchRow[];
    },

    async chunkCount(): Promise<number> {
      const { count, error } = await sb
        .from("chunks")
        .select("*", { count: "exact", head: true });
      if (error) throw new Error(`chunkCount failed: ${error.message}`);
      return count ?? 0;
    },
  };
}
