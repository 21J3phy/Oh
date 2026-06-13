"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/components/auth";
import { TopNav } from "@/components/topnav";

// Client-side auth guard. Everything behind it reads under the user's JWT, so
// RLS is the real gate — this is just UX (don't flash protected pages, bounce
// to /login when there's no session).
export function AppShell({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !session) router.replace("/login");
  }, [loading, session, router]);

  if (loading) {
    return (
      <div className="center-screen">
        <span className="spinner">loading…</span>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="center-screen">
        <span className="spinner">redirecting…</span>
      </div>
    );
  }

  return (
    <div className="wrap">
      <TopNav />
      {children}
    </div>
  );
}
