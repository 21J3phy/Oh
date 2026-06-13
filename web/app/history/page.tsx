"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/components/auth";
import { supabase } from "@/lib/supabase";
import { searchOwnHistory } from "@/lib/queries";
import type { MatchRow } from "@/lib/types";
import { fmtDateTime, relativeDay } from "@/lib/format";

interface ChunkRow {
  id: string;
  session_id: string;
  repo: string | null;
  tool: string;
  ts: string;
  text: string;
}

export default function HistoryPage() {
  return (
    <AppShell>
      <History />
    </AppShell>
  );
}

function History() {
  const { session, activeTeam } = useAuth();
  const userId = session?.user?.id;

  const [query, setQuery] = useState("");
  const [browse, setBrowse] = useState<ChunkRow[] | null>(null);
  const [results, setResults] = useState<MatchRow[] | null>(null);
  const [repoFilter, setRepoFilter] = useState<string>("");
  const [searching, setSearching] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Browse: the caller's own recent exchanges, scrubbed reasoning text.
  const loadBrowse = useCallback(async () => {
    if (!userId) return;
    setErr(null);
    let q = supabase()
      .from("chunks")
      .select("id, session_id, repo, tool, ts, text")
      .eq("author_id", userId)
      .order("ts", { ascending: false })
      .limit(60);
    if (repoFilter) q = q.eq("repo", repoFilter);
    const { data, error } = await q;
    if (error) setErr(error.message);
    else setBrowse((data ?? []) as ChunkRow[]);
  }, [userId, repoFilter]);

  useEffect(() => {
    if (results == null) void loadBrowse();
  }, [loadBrowse, results]);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const token = session?.access_token;
    if (!query.trim() || !token) return;
    setSearching(true);
    setErr(null);
    try {
      const hits = await searchOwnHistory(query.trim(), activeTeam?.author_name ?? "", token);
      setResults(hits);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Search failed.");
      setResults([]);
    } finally {
      setSearching(false);
    }
  }

  function clearSearch() {
    setResults(null);
    setQuery("");
  }

  const repos = browse ? [...new Set(browse.map((c) => c.repo ?? "unknown"))].sort() : [];

  return (
    <main>
      <h1 style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 28, letterSpacing: "-0.04em", marginTop: 32 }}>
        Your history
      </h1>
      <p className="muted" style={{ fontSize: 13, margin: "6px 0 18px" }}>
        Scrubbed reasoning from your own captured sessions — prompts, explanations, tool summaries (secrets masked, raw diffs
        dropped). Your sessions only.
      </p>

      <form onSubmit={runSearch} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <input
          type="search"
          placeholder="Ask your memory — e.g. why did we switch to RLS?"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 260 }}
        />
        <button className="btn" type="submit" disabled={searching || !query.trim()}>
          {searching ? "…" : "Search"}
        </button>
        {results != null && (
          <button type="button" className="btn ghost" onClick={clearSearch}>
            Clear
          </button>
        )}
      </form>

      {err && <p className="err">{err}</p>}

      {/* search results */}
      {results != null ? (
        <>
          <div className="section-title">
            {results.length} result{results.length === 1 ? "" : "s"} for &ldquo;{query}&rdquo;
          </div>
          {results.length === 0 && <p className="empty">Nothing matched. Try different words, or browse below.</p>}
          {results.map((r) => (
            <Exchange
              key={r.id}
              repo={r.repo}
              tool={r.tool}
              ts={r.ts}
              text={r.text}
              similarity={r.similarity}
            />
          ))}
        </>
      ) : (
        <>
          <div className="section-title" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            Recent exchanges
            {repos.length > 1 && (
              <select value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} style={{ width: "auto", padding: "5px 9px", fontSize: 12 }}>
                <option value="">all repos</option>
                {repos.map((r) => (
                  <option key={r} value={r === "unknown" ? "" : r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
          </div>
          {browse == null && <p className="spinner">loading…</p>}
          {browse?.length === 0 && <p className="empty">No captured exchanges yet. Run `oh backfill` to seed history.</p>}
          {browse?.map((c) => (
            <Exchange key={c.id} repo={c.repo} tool={c.tool} ts={c.ts} text={c.text} />
          ))}
        </>
      )}
      <div style={{ height: 40 }} />
    </main>
  );
}

function Exchange({
  repo,
  tool,
  ts,
  text,
  similarity,
}: {
  repo: string | null;
  tool: string;
  ts: string;
  text: string;
  similarity?: number;
}) {
  const [open, setOpen] = useState(false);
  const firstLine = (text.split("\n")[0] ?? "").replace(/^User:\s*/, "").trim();
  const preview = firstLine.length > 140 ? `${firstLine.slice(0, 139)}…` : firstLine;
  return (
    <div className="card" style={{ marginBottom: 12, cursor: "pointer" }} onClick={() => setOpen(!open)}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
        <span style={{ fontSize: 14 }}>{preview || <span className="faint">(no prompt text)</span>}</span>
        <span className="meta" style={{ whiteSpace: "nowrap" }}>{relativeDay(ts)}</span>
      </div>
      <div className="meta" style={{ marginTop: 8, display: "flex", gap: 10, alignItems: "center" }}>
        <span className="tag muted">{tool}</span>
        {repo && <span className="tag muted">{repo}</span>}
        {similarity != null && <span className="cite" style={{ fontSize: 11 }}>{Math.round(similarity * 100)}% match</span>}
        <span className="faint">{fmtDateTime(ts)}</span>
      </div>
      {open && (
        <pre
          style={{
            marginTop: 14,
            whiteSpace: "pre-wrap",
            fontFamily: "var(--mono)",
            fontSize: 13,
            color: "var(--bone-dim)",
            lineHeight: 1.6,
            borderTop: "1px solid var(--line)",
            paddingTop: 14,
          }}
        >
          {text}
        </pre>
      )}
    </div>
  );
}
