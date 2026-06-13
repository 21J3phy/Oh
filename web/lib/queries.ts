"use client";

import { supabase } from "@/lib/supabase";
import type { MetricsRow, MatchRow } from "@/lib/types";

const PAGE = 1000; // Supabase PostgREST default max rows per request.

// All of the caller's own exchange_metrics since `sinceIso` (null = all time),
// paginated. RLS (metrics_self: author_id = auth.uid()) already restricts this
// to the caller — individual-only by construction (ADR 0008).
export async function fetchOwnMetrics(sinceIso: string | null): Promise<MetricsRow[]> {
  const sb = supabase();
  const out: MetricsRow[] = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from("exchange_metrics").select("*").order("ts", { ascending: true }).range(from, from + PAGE - 1);
    if (sinceIso) q = q.gte("ts", sinceIso);
    const { data, error } = await q;
    if (error) throw new Error(`fetchOwnMetrics: ${error.message}`);
    const rows = (data ?? []) as MetricsRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// The caller's own chunk texts (id, text) since a date — for Tips, which join
// metrics rows to the prompt that opened each exchange. chunks are
// team-readable, so we explicitly scope to author_id = me.
export async function fetchOwnChunkTexts(
  userId: string,
  sinceIso: string | null,
): Promise<Array<{ id: string; text: string }>> {
  const sb = supabase();
  const out: Array<{ id: string; text: string }> = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb
      .from("chunks")
      .select("id, text")
      .eq("author_id", userId)
      .order("ts", { ascending: true })
      .range(from, from + PAGE - 1);
    if (sinceIso) q = q.gte("ts", sinceIso);
    const { data, error } = await q;
    if (error) throw new Error(`fetchOwnChunkTexts: ${error.message}`);
    const rows = (data ?? []) as Array<{ id: string; text: string }>;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

// Distinct repos the caller has captured sessions for — the truthful answer to
// "which repos am I sharing with Oh" (D4): derived from real session data, not
// the local ~/.oh capture allowlist (which lives on the user's machine).
export interface RepoSummary {
  repo: string;
  sessions: number;
  exchanges: number;
  lastTs: string;
}

export async function fetchOwnRepos(userId: string): Promise<RepoSummary[]> {
  const sb = supabase();
  const byRepo = new Map<string, { sessions: Set<string>; exchanges: number; lastTs: string }>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from("chunks")
      .select("repo, session_id, ts")
      .eq("author_id", userId)
      .order("ts", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`fetchOwnRepos: ${error.message}`);
    const rows = (data ?? []) as Array<{ repo: string | null; session_id: string; ts: string }>;
    for (const r of rows) {
      const key = r.repo ?? "unknown";
      let agg = byRepo.get(key);
      if (!agg) {
        agg = { sessions: new Set(), exchanges: 0, lastTs: r.ts };
        byRepo.set(key, agg);
      }
      agg.sessions.add(r.session_id);
      agg.exchanges += 1;
      if (r.ts > agg.lastTs) agg.lastTs = r.ts;
    }
    if (rows.length < PAGE) break;
  }
  return [...byRepo.entries()]
    .map(([repo, a]) => ({ repo, sessions: a.sessions.size, exchanges: a.exchanges, lastTs: a.lastTs }))
    .sort((a, b) => b.lastTs.localeCompare(a.lastTs));
}

// Semantic search over the caller's OWN chunks (D5, own-only for v1): embed the
// query via /api/embed, then match_chunks with p_author scoped to me.
export async function searchOwnHistory(
  query: string,
  authorName: string,
  accessToken: string,
): Promise<MatchRow[]> {
  const embedRes = await fetch("/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ texts: [query] }),
  });
  if (!embedRes.ok) {
    const e = await embedRes.json().catch(() => ({}));
    throw new Error(e.error ?? `embed failed (${embedRes.status})`);
  }
  const { embeddings } = (await embedRes.json()) as { embeddings: number[][] };
  const { data, error } = await supabase().rpc("match_chunks", {
    query_embedding: embeddings[0],
    match_count: 30,
    p_author: authorName,
  });
  if (error) throw new Error(`match_chunks: ${error.message}`);
  return (data ?? []) as MatchRow[];
}
