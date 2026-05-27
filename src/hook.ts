// Hook entrypoint. Fired by Claude/Codex Stop/SessionEnd hooks. Reads the
// hook payload from stdin, spawns a DETACHED `oh capture` so it never blocks
// the turn, and exits immediately.

import { spawn } from "node:child_process";
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

export async function runHook(tool: Tool, cliPath: string): Promise<void> {
  let payload: unknown = null;
  try {
    const raw = await readStdin();
    if (raw.trim()) payload = JSON.parse(raw);
  } catch {
    // Malformed/absent payload is fine — we fall back to a sweep below.
  }

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
