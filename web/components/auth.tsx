"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase";
import type { TeamRow } from "@/lib/types";

interface AuthState {
  session: Session | null;
  loading: boolean;
  /** The caller's teams (my_teams RPC). The first is treated as the active team. */
  teams: TeamRow[];
  activeTeam: TeamRow | null;
  email: string | null;
  refreshTeams: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState<TeamRow[]>([]);

  async function loadTeams() {
    const { data, error } = await supabase().rpc("my_teams");
    if (!error && data) setTeams(data as TeamRow[]);
  }

  useEffect(() => {
    const sb = supabase();
    sb.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
      if (data.session) void loadTeams();
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      if (s) void loadTeams();
      else setTeams([]);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const value: AuthState = {
    session,
    loading,
    teams,
    activeTeam: teams[0] ?? null,
    email: session?.user?.email ?? null,
    refreshTeams: loadTeams,
    signOut: async () => {
      await supabase().auth.signOut();
      setTeams([]);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
