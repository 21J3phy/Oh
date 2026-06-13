"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/components/auth";

// Email + password against the same hosted-Oh Supabase project the CLI uses
// (cli.ts signUp / signInWithPassword). The browser session resolves to the
// same auth.users.id, so the dashboard sees the same captured sessions.
export default function LoginPage() {
  const router = useRouter();
  const { session, loading } = useAuth();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && session) router.replace("/dashboard");
  }, [loading, session, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const sb = supabase();
      if (mode === "signup") {
        const { data, error } = await sb.auth.signUp({ email, password });
        if (error) throw error;
        if (!data.session) {
          setErr("Account created. Check your email to confirm, then sign in.");
          setMode("login");
          return;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      router.replace("/dashboard");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="sigil">
          oh<span className="dot">.</span>
        </div>
        <p className="muted" style={{ marginBottom: 24, fontSize: 13 }}>
          {mode === "login" ? "Sign in to your Oh account." : "Create your Oh account."}
        </p>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </div>
        <button className="btn" type="submit" disabled={busy} style={{ width: "100%" }}>
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>
        {err && <p className="err">{err}</p>}
        <p className="muted" style={{ marginTop: 18, fontSize: 12.5 }}>
          {mode === "login" ? "No account yet? " : "Already have one? "}
          <a
            style={{ color: "var(--phos)", cursor: "pointer" }}
            onClick={() => {
              setMode(mode === "login" ? "signup" : "login");
              setErr(null);
            }}
          >
            {mode === "login" ? "Create one" : "Sign in"}
          </a>
        </p>
      </form>
    </div>
  );
}
