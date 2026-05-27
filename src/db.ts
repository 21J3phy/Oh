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

export function chunkId(sessionId: string, exchangeIndex: number): string {
  return `${sessionId}:${exchangeIndex}`;
}

export interface Db {
  raw: SupabaseClient;
  upsertSession(s: SessionMeta): Promise<void>;
  upsertChunks(exchanges: Exchange[], embeddings: number[][]): Promise<void>;
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
