// Capture: read a session file, turn new exchanges into scrubbed, embedded
// chunks, and upsert them into the Team Brain. Idempotent — chunk ids are
// deterministic ('<sessionId>:<index>') so re-runs update rather than
// duplicate, and a per-session offset file skips unchanged files cheaply.

import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { ensureDirs, LAST_SESSION_PATH, NUDGES_DIR, OFFSETS_DIR } from "./config.js";
import type { Config, Exchange, ParseResult, SessionMeta, Tool } from "./types.js";
import { parseClaude } from "./parse/claude.js";
import { parseCodex } from "./parse/codex.js";
import { repoFromCwd, toExchanges } from "./normalize.js";
import { scrubText } from "./scrub.js";
import { detectRabbitHole, formatNudge } from "./insights.js";
import { lastSnippet, refreshInsightsCache, type LastSession } from "./brief.js";
import type { Db } from "./db.js";
import type { Embedder } from "./embed.js";
import { log } from "./log.js";

export const CLAUDE_ROOT = join(homedir(), ".claude", "projects");
export const CODEX_ROOT = join(homedir(), ".codex", "sessions");

/** Bump to force a one-time metrics re-sweep of already-captured sessions. */
const METRICS_V = 1;

interface OffsetState {
  bytes: number;
  mtimeMs: number;
  processed: number; // number of exchanges already embedded
  updatedAt: string;
  /** exchange_metrics schema version this session was last swept with. */
  metricsV?: number;
}

function statePath(sessionId: string): string {
  // sessionIds are filename-safe (UUID/ULID); keep a flat dir.
  return join(OFFSETS_DIR, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

function loadState(sessionId: string): OffsetState | null {
  const p = statePath(sessionId);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as OffsetState;
  } catch {
    return null;
  }
}

function saveState(sessionId: string, state: OffsetState): void {
  ensureDirs();
  writeFileSync(statePath(sessionId), JSON.stringify(state));
}

function sessionIdFromPath(path: string, parsed: ParseResult): string {
  return parsed.sessionId ?? basename(path, ".jsonl");
}

// --- Rabbit-hole Nudge (ADR 0007) -----------------------------------------
// Capture writes at most one nudge file per session; the next Stop hook
// surfaces it in-session and renames it to .done. Self-only, never blocks.

/** Don't nudge sessions that aren't live — backfill sweeps old history. */
const NUDGE_FRESHNESS_MS = 30 * 60_000;

export function nudgePath(sessionId: string): string {
  return join(NUDGES_DIR, `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
}

function maybeWriteNudge(sessionId: string, exchanges: Exchange[]): void {
  const last = exchanges[exchanges.length - 1];
  if (!last) return;
  const lastEnd = Date.parse(last.metrics.endedAt);
  if (Number.isNaN(lastEnd) || Date.now() - lastEnd > NUDGE_FRESHNESS_MS) return;
  const pending = nudgePath(sessionId);
  if (existsSync(pending) || existsSync(`${pending}.done`)) return; // one per session
  const hit = detectRabbitHole(
    exchanges.map((ex) => ({
      isCorrection: ex.metrics.isCorrection,
      errors: ex.metrics.errors,
      freshTokens: ex.metrics.inputTokens + ex.metrics.outputTokens + ex.metrics.cacheWriteTokens,
    })),
  );
  if (!hit) return;
  ensureDirs();
  writeFileSync(
    pending,
    JSON.stringify({
      sessionId,
      message: formatNudge(hit.streak, hit.tokens),
      createdAt: new Date().toISOString(),
    }),
  );
  log("capture", `${sessionId}: rabbit-hole nudge written (streak ${hit.streak}, ~${hit.tokens} tokens)`);
}

const projectKeyCache = new Map<string, string | null>();

function normalizeRemote(url: string): string {
  return url
    .replace(/^git@([^:]+):/, "$1/")
    .replace(/^ssh:\/\/git@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

/** Resolve a session's cwd to its normalized git remote (cached). Null if unknown. */
export function resolveProjectKey(cwd: string | null): string | null {
  if (!cwd) return null;
  const hit = projectKeyCache.get(cwd);
  if (hit !== undefined) return hit;
  let key: string | null = null;
  if (existsSync(cwd)) {
    try {
      const out = execSync("git config --get remote.origin.url", {
        cwd,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (out) key = normalizeRemote(out);
    } catch {
      // not a git repo / no origin remote
    }
  }
  projectKeyCache.set(cwd, key);
  return key;
}

/** True if the cwd's git project is allowed by the (optional) repos allowlist. */
export function repoAllowed(cwd: string | null, repos: string[] | undefined): boolean {
  if (!repos || repos.length === 0) return true; // no filter = capture everything
  const key = resolveProjectKey(cwd);
  if (!key) return false;
  return repos.some((r) => key.includes(r.trim().toLowerCase()));
}

/**
 * Track the newest session this machine has seen, for the brief's "Last on"
 * line. Prefers the tool's own one-line summary (Claude's ai-title); falls
 * back to the last exchange's opening prompt. Newest-wins across sweeps.
 */
function recordLastSession(parsed: ParseResult, exchanges: Exchange[]): void {
  const last = exchanges[exchanges.length - 1];
  if (!last) return;
  try {
    const ts = last.metrics.endedAt;
    if (existsSync(LAST_SESSION_PATH)) {
      const prev = JSON.parse(readFileSync(LAST_SESSION_PATH, "utf8")) as LastSession;
      if (Date.parse(prev.ts) >= Date.parse(ts)) return;
    }
    // Prefer the tool's own title; fall back to the last prompt — but don't
    // let a throwaway ("hi", "test") session steal the where-you-left-off slot.
    const summary = parsed.summary?.trim() || lastSnippet(last.reasoningText);
    if (!parsed.summary?.trim() && summary.length < 15) return;
    const entry: LastSession = { summary, repo: last.repo, ts };
    ensureDirs();
    writeFileSync(LAST_SESSION_PATH, JSON.stringify(entry));
  } catch {
    // decoration only — never fail capture over it
  }
}

export interface CaptureResult {
  sessionId: string | null;
  tool: Tool;
  exchanges: number;
  embedded: number;
  skipped: boolean;
}

/** Capture a single session file from its last offset. */
export async function captureFile(
  path: string,
  tool: Tool,
  cfg: Config,
  db: Db,
  embedder: Embedder,
): Promise<CaptureResult> {
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(path);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch {
    return { sessionId: null, tool, exchanges: 0, embedded: 0, skipped: true };
  }

  const content = readFileSync(path, "utf8");
  const parsed = tool === "claude" ? parseClaude(content) : parseCodex(content);
  const sessionId = sessionIdFromPath(path, parsed);

  // Respect the git-project allowlist — skip sessions from other projects.
  if (!repoAllowed(parsed.cwd, cfg.repos)) {
    return { sessionId, tool, exchanges: 0, embedded: 0, skipped: true };
  }

  // Cheap short-circuit: nothing changed since we last processed this file
  // (and its metrics are current — a METRICS_V bump forces one re-sweep).
  const prev = loadState(sessionId);
  if (
    prev &&
    prev.bytes === size &&
    Math.abs(prev.mtimeMs - mtimeMs) < 1 &&
    prev.metricsV === METRICS_V
  ) {
    return { sessionId, tool, exchanges: prev.processed, embedded: 0, skipped: true };
  }

  const exchanges = toExchanges(parsed, {
    author: cfg.author,
    includeThinking: cfg.includeThinking,
    sessionId,
  });
  if (exchanges.length === 0) {
    saveState(sessionId, {
      bytes: size,
      mtimeMs,
      processed: 0,
      updatedAt: new Date().toISOString(),
      metricsV: METRICS_V,
    });
    return { sessionId, tool, exchanges: 0, embedded: 0, skipped: false };
  }

  // Re-embed only the tail: any new exchange plus the previously-last one (it
  // may have grown). Deterministic ids mean the upsert overwrites cleanly.
  const fromIndex = Math.max(0, (prev?.processed ?? 0) - 1);
  const fresh = exchanges
    .filter((ex) => ex.index >= fromIndex)
    .map((ex) => ({ ...ex, reasoningText: scrubText(ex.reasoningText) }));

  // Metrics carry no text and no embedding — tail-only normally, the whole
  // session on the first METRICS_V-aware pass (backfills pre-v0.1 captures).
  const metricsTargets =
    prev?.metricsV === METRICS_V ? exchanges.filter((ex) => ex.index >= fromIndex) : exchanges;

  // Metrics must never break capture — e.g. the team store predates migration
  // 0002. On failure, keep capturing chunks and leave metricsV unset so the
  // next sweep retries once the table exists.
  let metricsOk = true;
  if (fresh.length > 0 || metricsTargets.length > 0) {
    const firstExchange = exchanges[0]!;
    const lastExchange = exchanges[exchanges.length - 1]!;
    const cwd = parsed.cwd ?? firstExchange.cwd;
    const meta: SessionMeta = {
      sessionId,
      tool,
      author: cfg.author,
      cwd,
      repo: repoFromCwd(cwd),
      startedAt: firstExchange.ts,
      lastSeenAt: lastExchange.ts,
    };
    await db.upsertSession(meta);
    if (fresh.length > 0) {
      const embeddings = await embedder.embed(fresh.map((e) => e.reasoningText));
      await db.upsertChunks(fresh, embeddings);
    }
    try {
      await db.upsertMetrics(metricsTargets);
    } catch (err) {
      metricsOk = false;
      log(
        "capture",
        `metrics skipped (apply migrations/0002_exchange_metrics.sql?) — ${(err as Error).message}`,
        true,
      );
    }
  }

  maybeWriteNudge(sessionId, exchanges);
  recordLastSession(parsed, exchanges);

  saveState(sessionId, {
    bytes: size,
    mtimeMs,
    processed: exchanges.length,
    updatedAt: new Date().toISOString(),
    ...(metricsOk ? { metricsV: METRICS_V } : {}),
  });

  return {
    sessionId,
    tool,
    exchanges: exchanges.length,
    embedded: fresh.length,
    skipped: false,
  };
}

function listJsonl(root: string, sinceMs: number | null): string[] {
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root, { recursive: true }) as string[];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rel of entries) {
    if (!rel.endsWith(".jsonl")) continue;
    const path = join(root, rel);
    if (sinceMs != null) {
      try {
        if (statSync(path).mtimeMs < sinceMs) continue;
      } catch {
        continue;
      }
    }
    out.push(path);
  }
  return out;
}

export interface SweepResult {
  files: number;
  sessions: number;
  embedded: number;
  skipped: number;
  errors: number;
}

/** Sweep both tools' session dirs (optionally restricted to one tool / since a date). */
export async function captureAll(
  cfg: Config,
  db: Db,
  embedder: Embedder,
  opts: { tool?: Tool; sinceMs?: number | null } = {},
): Promise<SweepResult> {
  const sinceMs = opts.sinceMs ?? null;
  const targets: Array<{ tool: Tool; path: string }> = [];
  if (!opts.tool || opts.tool === "claude") {
    for (const p of listJsonl(CLAUDE_ROOT, sinceMs)) targets.push({ tool: "claude", path: p });
  }
  if (!opts.tool || opts.tool === "codex") {
    for (const p of listJsonl(CODEX_ROOT, sinceMs)) targets.push({ tool: "codex", path: p });
  }

  const result: SweepResult = { files: targets.length, sessions: 0, embedded: 0, skipped: 0, errors: 0 };
  for (const { tool, path } of targets) {
    try {
      const r = await captureFile(path, tool, cfg, db, embedder);
      if (r.skipped) result.skipped++;
      else result.sessions++;
      result.embedded += r.embedded;
      if (r.embedded > 0) {
        log("capture", `${tool} ${r.sessionId}: +${r.embedded} chunks (${r.exchanges} exchanges)`);
      }
    } catch (err) {
      result.errors++;
      log("capture", `ERROR ${tool} ${path}: ${(err as Error).message}`, true);
    }
  }

  // Keep the session-start brief's local cache warm. We're the detached
  // post-turn process, so this latency is invisible; offline just means the
  // brief goes quiet rather than ever blocking a session.
  try {
    await refreshInsightsCache(cfg, db);
  } catch (err) {
    log("capture", `insights cache refresh skipped — ${(err as Error).message}`);
  }

  return result;
}
