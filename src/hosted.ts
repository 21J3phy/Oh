// Hosted Oh (ADR 0010): the Oh-owned multi-tenant store. The URL and anon key
// are public by design (RLS does all enforcement); they ship as constants so
// `oh signup` needs zero configuration. Self-host mode never touches this file.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { saveConfig } from "./config.js";
import type { Config, HostedConfig } from "./types.js";

// Filled at provision time — see migrations/hosted/0001_hosted.sql and ADR 0010.
export const HOSTED_URL = "__OH_HOSTED_URL__";
export const HOSTED_ANON_KEY = "__OH_HOSTED_ANON_KEY__";
/** The embedding proxy (holds Oh's OpenAI key; verifies the user's JWT). */
export const EMBED_ENDPOINT = "https://oh-landing-mu.vercel.app/api/embed";

export function hostedConfigured(): boolean {
  return !HOSTED_URL.startsWith("__");
}

export function bareHostedClient(): SupabaseClient {
  if (!hostedConfigured()) {
    throw new Error("hosted Oh is not provisioned in this build — use self-host mode or update oh-brain");
  }
  return createClient(HOSTED_URL, HOSTED_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Client authenticated as the hosted user. Restores the stored session
 * (refreshing if the access token aged out) and persists rotated tokens back
 * to config so long-lived hooks keep working.
 */
export async function hostedClient(cfg: Config): Promise<SupabaseClient> {
  const h = cfg.hosted;
  if (!h?.accessToken || !h.refreshToken) {
    throw new Error("not logged in to hosted Oh — run `oh login`");
  }
  const sb = bareHostedClient();
  const { data, error } = await sb.auth.setSession({
    access_token: h.accessToken,
    refresh_token: h.refreshToken,
  });
  if (error || !data.session) {
    throw new Error(`hosted session expired — run \`oh login\` (${error?.message ?? "no session"})`);
  }
  if (data.session.access_token !== h.accessToken) {
    saveConfig({
      hosted: {
        ...h,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
      },
    });
    h.accessToken = data.session.access_token;
    h.refreshToken = data.session.refresh_token;
  }
  return sb;
}

/** Tenant columns stamped on every hosted row. */
export function tenantCols(cfg: Config): { team_id: string; author_id: string } {
  const h = requireTeam(cfg);
  return { team_id: h.teamId!, author_id: h.userId };
}

export function requireTeam(cfg: Config): HostedConfig {
  if (cfg.mode !== "hosted" || !cfg.hosted) {
    throw new Error("not in hosted mode — run `oh login` then `oh team create` or `oh team join`");
  }
  if (!cfg.hosted.teamId) {
    throw new Error("no team yet — run `oh team create \"<name>\"` or `oh team join <code>`");
  }
  return cfg.hosted;
}
