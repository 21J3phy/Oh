"use client";

import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { useAuth } from "@/components/auth";
import { supabase } from "@/lib/supabase";
import { fetchOwnRepos, type RepoSummary } from "@/lib/queries";
import type { MemberRow } from "@/lib/types";
import { relativeDay } from "@/lib/format";

export default function TeamPage() {
  return (
    <AppShell>
      <Team />
    </AppShell>
  );
}

function Team() {
  const { session, teams, activeTeam, refreshTeams } = useAuth();
  const userId = session?.user?.id;
  const isOwner = activeTeam?.role === "owner";

  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [repos, setRepos] = useState<RepoSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadMembers = useCallback(async () => {
    if (!activeTeam) {
      setMembers([]);
      return;
    }
    const { data, error } = await supabase().from("members").select("*").eq("team_id", activeTeam.team_id).order("joined_at");
    if (error) setErr(error.message);
    else setMembers((data ?? []) as MemberRow[]);
  }, [activeTeam]);

  const loadRepos = useCallback(async () => {
    if (!userId) return;
    try {
      setRepos(await fetchOwnRepos(userId));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load repos.");
      setRepos([]);
    }
  }, [userId]);

  useEffect(() => {
    void loadMembers();
    void loadRepos();
  }, [loadMembers, loadRepos]);

  async function call(fn: string, args: Record<string, unknown>, after: () => Promise<void>) {
    setErr(null);
    setBusy(true);
    try {
      const { error } = await supabase().rpc(fn, args);
      if (error) throw error;
      await after();
    } catch (e) {
      setErr(e instanceof Error ? e.message : `${fn} failed`);
    } finally {
      setBusy(false);
    }
  }

  // No team yet → onboarding (create or join).
  if (members != null && !activeTeam) {
    return <NoTeam onDone={refreshTeams} />;
  }

  return (
    <main>
      <h1 style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 28, letterSpacing: "-0.04em", marginTop: 32 }}>
        Team
      </h1>
      {err && <p className="err">{err}</p>}

      {activeTeam && (
        <>
          {/* invite */}
          <div className="section-title">Invite</div>
          <div className="card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
            <div>
              <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>
                Share this code — teammates run <span className="code">oh team join &lt;code&gt;</span>
              </div>
              <span className="code" style={{ fontSize: 18, letterSpacing: "0.1em" }}>
                {activeTeam.invite_code ?? "—"}
              </span>
            </div>
            {isOwner && (
              <button
                className="btn ghost"
                disabled={busy}
                onClick={() => {
                  if (confirm("Regenerate the invite code? The current code stops working immediately.")) {
                    void call("regenerate_invite", { p_team: activeTeam.team_id }, refreshTeams);
                  }
                }}
              >
                Regenerate
              </button>
            )}
          </div>

          {/* roster */}
          <div className="section-title">Members ({members?.length ?? 0})</div>
          <div className="card">
            {members?.map((m) => {
              const isSelf = m.user_id === userId;
              return (
                <div className="row" key={m.user_id}>
                  <div>
                    <span style={{ fontFamily: "var(--display)", fontWeight: 500 }}>{m.author_name}</span>{" "}
                    {isSelf && <span className="tag muted">you</span>}{" "}
                    <span className={`tag ${m.role === "owner" ? "" : "muted"}`}>{m.role}</span>
                    <div className="meta">joined {relativeDay(m.joined_at)}</div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {isSelf && (
                      <button
                        className="btn ghost sm"
                        disabled={busy}
                        onClick={() => {
                          const name = prompt("Your display name on this team:", m.author_name);
                          if (name && name.trim()) {
                            void call("rename_member", { p_team: activeTeam.team_id, p_name: name.trim() }, async () => {
                              await loadMembers();
                              await refreshTeams();
                            });
                          }
                        }}
                      >
                        Rename
                      </button>
                    )}
                    {isOwner && !isSelf && m.role !== "owner" && (
                      <button
                        className="btn danger sm"
                        disabled={busy}
                        onClick={() => {
                          if (confirm(`Remove ${m.author_name} from the team? They lose access to team memory.`)) {
                            void call("remove_member", { p_team: activeTeam.team_id, p_user: m.user_id }, loadMembers);
                          }
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
            {members?.length === 0 && <p className="empty">No members yet.</p>}
          </div>

          {teams.length > 1 && (
            <p className="faint" style={{ fontSize: 12, marginTop: 10 }}>
              You&apos;re on {teams.length} teams. The web app shows your first team; switch teams from the CLI for now.
            </p>
          )}
        </>
      )}

      {/* connected repositories — read-only, derived from session data (D4) */}
      <div className="section-title">Connected repositories</div>
      <p className="faint" style={{ fontSize: 12.5, marginTop: -8, marginBottom: 14 }}>
        Repos Oh has captured your sessions from. (The capture allowlist lives in <span className="code">~/.oh/config.json</span> on
        your machine and is edited via the CLI.)
      </p>
      <div className="card">
        {repos == null && <p className="spinner">loading…</p>}
        {repos?.map((r) => (
          <div className="row" key={r.repo}>
            <div>
              <span style={{ fontFamily: "var(--display)", fontWeight: 500 }}>{r.repo}</span>
              <div className="meta">
                {r.sessions} session{r.sessions === 1 ? "" : "s"} · {r.exchanges} exchanges
              </div>
            </div>
            <span className="meta">active {relativeDay(r.lastTs)}</span>
          </div>
        ))}
        {repos?.length === 0 && <p className="empty">No captured repos yet. Run `oh backfill` to seed history.</p>}
      </div>
      <div style={{ height: 40 }} />
    </main>
  );
}

function NoTeam({ onDone }: { onDone: () => Promise<void> }) {
  const [tab, setTab] = useState<"create" | "join">("create");
  const [name, setName] = useState("");
  const [author, setAuthor] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const sb = supabase();
      if (tab === "create") {
        const { error } = await sb.rpc("create_team", { p_name: name, p_author: author });
        if (error) throw error;
      } else {
        const { error } = await sb.rpc("join_team", { p_code: code.trim(), p_author: author });
        if (error) throw error;
      }
      await onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1 style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 28, letterSpacing: "-0.04em", marginTop: 32 }}>
        Set up your team
      </h1>
      <p className="muted" style={{ fontSize: 13, margin: "6px 0 20px" }}>
        You&apos;re not on a team yet. Create one, or join with an invite code.
      </p>
      <div className="topnav" style={{ gap: 6, marginBottom: 16 }}>
        <button className={`btn sm ${tab === "create" ? "" : "ghost"}`} onClick={() => setTab("create")}>
          Create
        </button>
        <button className={`btn sm ${tab === "join" ? "" : "ghost"}`} onClick={() => setTab("join")}>
          Join
        </button>
      </div>
      <form className="card" onSubmit={submit} style={{ maxWidth: 460 }}>
        {tab === "create" ? (
          <div className="field">
            <label>Team name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
        ) : (
          <div className="field">
            <label>Invite code</label>
            <input type="text" value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
        )}
        <div className="field">
          <label>Your display name</label>
          <input type="text" value={author} onChange={(e) => setAuthor(e.target.value)} required />
        </div>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? "…" : tab === "create" ? "Create team" : "Join team"}
        </button>
        {err && <p className="err">{err}</p>}
      </form>
      <div style={{ height: 40 }} />
    </main>
  );
}
