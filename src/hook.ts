// Hook entrypoint. Fired by Claude/Codex Stop/SessionEnd hooks. Reads the
// hook payload from stdin, surfaces any pending rabbit-hole Nudge for this
// session (written by an earlier detached capture — ADR 0007), spawns a
// DETACHED `oh capture` so it never blocks the turn, and exits immediately.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { nudgePath } from "./capture.js";
import {
  formatBrief,
  readBriefMarker,
  readInsightsCache,
  shouldShowBrief,
  writeBriefMarker,
} from "./brief.js";
import { readPartialConfig } from "./config.js";
import type { Tool } from "./types.js";
import { log } from "./log.js";

function readStdin(timeoutMs = 2000): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
    setTimeout(finish, timeoutMs).unref?.();
  });
}

/** Claude passes transcript_path (+ session_id, cwd). Codex may not pass a path. */
function findTranscriptPath(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const candidate = p["transcript_path"] ?? p["transcriptPath"] ?? p["path"];
  return typeof candidate === "string" && candidate ? candidate : null;
}

function findSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const candidate = p["session_id"] ?? p["sessionId"];
  return typeof candidate === "string" && candidate ? candidate : null;
}

/**
 * If a detached capture flagged this session as circling, show the one-shot
 * Nudge via the hook's `systemMessage` output (warning-style, never blocks)
 * and mark it consumed. Works in Claude and Codex ≥0.13x — both render
 * systemMessage from hook output.
 */
function deliverNudge(sessionId: string | null): void {
  if (!sessionId) return;
  const pending = nudgePath(sessionId);
  try {
    if (!existsSync(pending)) return;
    const { message } = JSON.parse(readFileSync(pending, "utf8")) as { message?: string };
    renameSync(pending, `${pending}.done`); // consume before printing — at most once
    if (message) {
      process.stdout.write(JSON.stringify({ systemMessage: message }) + "\n");
      log("hook", `${sessionId}: delivered rabbit-hole nudge`);
    }
  } catch (err) {
    log("hook", `nudge delivery failed — ${(err as Error).message}`, true);
  }
}

/**
 * SessionStart: show the daily brief (Insights' ambient surface — people
 * forget to run `oh insights`). Pure local-cache read, zero network; the
 * cache is kept warm by the detached capture after every turn.
 *
 * Delivery quirk (verified against the hooks docs): SessionStart does NOT
 * display `systemMessage` to the user — stdout/JSON becomes context for the
 * model instead. So we emit `additionalContext` instructing the agent to
 * surface the brief at the top of its first reply.
 */
function deliverBrief(): void {
  try {
    const now = Date.now();
    const cadence = readPartialConfig().brief ?? "session";
    if (!shouldShowBrief(cadence, readBriefMarker(), now)) return;
    const cache = readInsightsCache(now);
    if (!cache) return; // no/stale cache — silence beats wrong numbers
    const message = formatBrief(cache);
    if (!message) return;
    writeBriefMarker(now); // mark before printing — never twice in a day
    const instruction =
      `The user's Oh session brief is below. Show it VERBATIM in a fenced code block at the very top of your next reply, then answer their message directly. Do NOT add any commentary about the brief — no recap of what they were working on, no "want to pick up where you left off?" — they can read it themselves; just proceed with what they asked.\n\n${message}`;
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: instruction },
      }) + "\n",
    );
    log("hook", "delivered session-start brief (additionalContext)");
  } catch (err) {
    log("hook", `brief delivery failed — ${(err as Error).message}`, true);
  }
}

function eventName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const e = (payload as Record<string, unknown>)["hook_event_name"];
  return typeof e === "string" ? e : null;
}

export async function runHook(tool: Tool, cliPath: string): Promise<void> {
  let payload: unknown = null;
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    // Malformed/absent payload is fine — we fall back to a sweep below.
  }

  // Session opening: brief only — nothing new to capture yet. SessionStart
  // also fires for resume/clear/compact of EXISTING sessions; delivering there
  // hands the brief to a mid-conversation model (which won't surface it) and
  // burns the daily marker — only a genuine startup gets the brief.
  if (eventName(payload) === "SessionStart") {
    const source = (payload as Record<string, unknown> | null)?.["source"];
    if (source === "startup" || source == null) deliverBrief();
    process.exit(0);
  }

  deliverNudge(findSessionId(payload));

  const transcript = findTranscriptPath(payload);
  const args = transcript
    ? ["capture", "--file", transcript, "--tool", tool]
    : // No explicit file (e.g. Codex) — sweep this tool's recent sessions.
      ["capture", "--all", "--tool", tool, "--since", "2d"];

  try {
    const child = spawn(process.execPath, [cliPath, ...args], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    log("hook", `${tool}: spawned capture (${transcript ? "file" : "sweep"})`);
  } catch (err) {
    log("hook", `${tool}: spawn failed — ${(err as Error).message}`, true);
  }

  // Never block the turn.
  process.exit(0);
}
