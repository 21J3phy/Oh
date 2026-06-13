"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser client for the hosted-Oh project. Persists the session in
// localStorage and auto-refreshes — the same identity (auth.users.id) the
// `oh` CLI authenticates as, so RLS scopes every read to the caller's team.
// All security lives in Postgres RLS + SECURITY DEFINER RPCs; this client
// only ever holds the public anon key + the user's own JWT.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!url || !anon) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY — copy .env.example to .env.local",
    );
  }
  if (!client) {
    client = createClient(url, anon, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
  }
  return client;
}
