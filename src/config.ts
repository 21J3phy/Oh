// Read/write ~/.oh/config.json and the local-state paths under ~/.oh.

import { homedir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Config } from "./types.js";

export const OH_DIR = join(homedir(), ".oh");
export const CONFIG_PATH = join(OH_DIR, "config.json");
export const OFFSETS_DIR = join(OH_DIR, "offsets");
export const LOGS_DIR = join(OH_DIR, "logs");
export const NUDGES_DIR = join(OH_DIR, "nudges");
/** Local-mode store (mode === "local"): the whole Team Brain, on this machine. */
export const LOCAL_DIR = join(OH_DIR, "local");
/** Where the in-process embedding model is cached so it works offline forever
 *  after a single first fetch (air-gap: copy this dir onto the target machine). */
export const MODELS_DIR = join(OH_DIR, "models");
export const SCHEMA_OUT_PATH = join(OH_DIR, "schema.sql");
export const INSIGHTS_CACHE_PATH = join(OH_DIR, "insights-cache.json");
/** Per-day totals, keyed by local YYYY-MM-DD — survives the day rolling over so
 *  people can look back at past days (the cache only holds today + this week). */
export const DAILY_HISTORY_PATH = join(OH_DIR, "insights-daily.json");
export const BRIEF_MARKER_PATH = join(OH_DIR, "brief-last-shown");
export const BRIEF_TIP_INDEX_PATH = join(OH_DIR, "brief-tip-index");
export const LAST_SESSION_PATH = join(OH_DIR, "last-session.json");
export const INCOGNITO_PATH = join(OH_DIR, "incognito");

const DEFAULTS = {
  embeddingModel: "text-embedding-3-small",
  includeThinking: true,
  recencyHalfLifeDays: 30,
  recencyWeight: 0.25,
  repoScopedAsk: true,
} satisfies Partial<Config>;

const REQUIRED_KEYS = ["author", "supabaseUrl", "supabaseKey", "openaiKey"] as const;

export function ensureDirs(): void {
  for (const dir of [OH_DIR, OFFSETS_DIR, LOGS_DIR, NUDGES_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function configExists(): boolean {
  return existsSync(CONFIG_PATH);
}

/** Load config, applying defaults and validating that required fields are present. */
export function loadConfig(): Config {
  if (!configExists()) {
    throw new Error(
      `No Oh config at ${CONFIG_PATH}. Run \`oh init\` first.`,
    );
  }
  let raw: Partial<Config>;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch (err) {
    throw new Error(`Could not parse ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  const cfg = { ...DEFAULTS, ...raw } as Config;
  if (cfg.mode === "local") {
    // Local mode needs no keys at all — that's the whole point (ADR 0013).
    if (!cfg.author) throw new Error("Oh local config is missing author. Run `oh init --local`.");
    return cfg;
  }
  if (cfg.mode === "hosted") {
    // Hosted mode needs no keys — auth lives in the hosted block (ADR 0010).
    if (!cfg.author) throw new Error("Oh config is missing author. Run `oh login`.");
    if (!cfg.hosted?.accessToken) {
      throw new Error("Not logged in to hosted Oh. Run `oh login`.");
    }
    return cfg;
  }
  const missing = REQUIRED_KEYS.filter((k) => !cfg[k]);
  if (missing.length > 0) {
    throw new Error(
      `Oh config is missing required field(s): ${missing.join(", ")}. Run \`oh init\`.`,
    );
  }
  return cfg;
}

/** Read whatever config exists (or {}) without validating — used by `oh init`. */
export function readPartialConfig(): Partial<Config> {
  if (!configExists()) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
  } catch {
    return {};
  }
}

// --- Incognito (ADR 0011) -------------------------------------------------
// Developer control of the shared record: while incognito, capture advances its
// byte offset and stores NOTHING, leaving a permanent hole that `oh backfill`
// can never recover. Two switches, OR'd together:
//   - the marker file ~/.oh/incognito  (toggled by `oh pause` / `oh resume`)
//   - the env var OH_INCOGNITO=1        (per-session — set it before launching
//     your agent; the capture child inherits it through the hook)

/** True if capture should record nothing right now. */
export function isIncognito(): boolean {
  const env = process.env.OH_INCOGNITO;
  if (env && env !== "0" && env.toLowerCase() !== "false") return true;
  return existsSync(INCOGNITO_PATH);
}

/** Read when global incognito was switched on (null if off / unknown). */
export function incognitoSince(): string | null {
  if (!existsSync(INCOGNITO_PATH)) return null;
  try {
    const { since } = JSON.parse(readFileSync(INCOGNITO_PATH, "utf8")) as { since?: string };
    return typeof since === "string" ? since : null;
  } catch {
    return "";
  }
}

/** Switch global incognito on/off. Returns the new state. */
export function setIncognito(on: boolean): boolean {
  ensureDirs();
  if (on) {
    writeFileSync(INCOGNITO_PATH, JSON.stringify({ since: new Date().toISOString() }), { mode: 0o600 });
  } else if (existsSync(INCOGNITO_PATH)) {
    rmSync(INCOGNITO_PATH);
  }
  return on;
}

/** Merge `partial` into the existing config and write it back (pretty-printed). */
export function saveConfig(partial: Partial<Config>): Config {
  ensureDirs();
  const merged = { ...DEFAULTS, ...readPartialConfig(), ...partial } as Config;
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2) + "\n", {
    mode: 0o600,
  });
  return merged;
}
