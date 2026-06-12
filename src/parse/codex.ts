// Parse a Codex CLI rollout (.jsonl) into common ParsedEvents.
//
// Layout (verified against real files): one JSON event per line with top-level
// `timestamp`, `type`, `payload`. The canonical conversation lives in
// `response_item` events; `event_msg/*` events mirror them for the TUI, so we
// ignore `event_msg` to avoid double-counting. `session_meta` (first line) and
// `turn_context` carry the cwd (which can change mid-session).
//
// We keep: user/assistant `message` content, `reasoning.summary`, and one-line
// summaries of `function_call`. We drop `function_call_output` (raw output) and
// `developer`/`system`-role messages (injected preamble).

import type { ParsedEvent, ParseResult } from "../types.js";
import { firstLine, stripWrapperBlocks } from "./util.js";

const USER_WRAPPER_TAGS = [
  "permissions instructions",
  "environment_context",
  "user_instructions",
  "collaboration_mode",
];

function cleanUserText(s: string): string {
  return stripWrapperBlocks(s, USER_WRAPPER_TAGS);
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b: any) => (b && typeof b.text === "string" ? b.text : ""))
    .join("\n")
    .trim();
}

function summaryText(summary: unknown): string {
  if (!Array.isArray(summary)) return "";
  return summary
    .map((b: any) => (b && typeof b.text === "string" ? b.text : ""))
    .join("\n")
    .trim();
}

function summarizeTool(name: unknown, argsRaw: unknown): string {
  const n = typeof name === "string" && name ? name : "tool";
  let args: Record<string, unknown> = {};
  if (typeof argsRaw === "string") {
    try {
      args = JSON.parse(argsRaw) as Record<string, unknown>;
    } catch {
      return argsRaw.trim() ? `${n}: ${firstLine(argsRaw)}` : n;
    }
  } else if (argsRaw && typeof argsRaw === "object") {
    args = argsRaw as Record<string, unknown>;
  }
  const cmd = args["cmd"] ?? args["command"];
  if (Array.isArray(cmd)) return `${n}: ${firstLine(cmd.join(" "))}`;
  if (typeof cmd === "string" && cmd) return `${n}: ${firstLine(cmd)}`;
  const path = args["path"] ?? args["file_path"] ?? args["workdir"];
  if (typeof path === "string" && path) return `${n}: ${firstLine(path)}`;
  if (typeof args["patch"] === "string") return `${n}: ${firstLine(args["patch"])}`;
  return n;
}

/** function_call_output payloads embed the exit code as JSON-in-a-string. */
function outputIsError(output: unknown): boolean {
  if (typeof output !== "string") return false;
  const m = output.match(/"exit_code"\s*:\s*(-?\d+)/);
  return m != null && m[1] !== "0";
}

export function parseCodex(content: string): ParseResult {
  const events: ParsedEvent[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  // token_count events carry cumulative totals — diff them into per-event deltas.
  // Codex's input_tokens INCLUDES cached_input_tokens; split them apart so the
  // stored semantics match Claude's (input = uncached input).
  let prevTotals = { input: 0, cached: 0, output: 0 };

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const ts: string =
      typeof e.timestamp === "string" ? e.timestamp : new Date(0).toISOString();
    const p = e.payload ?? {};

    if (e.type === "session_meta") {
      if (typeof p.id === "string") sessionId = p.id;
      if (typeof p.cwd === "string") cwd = p.cwd;
      continue;
    }
    if (e.type === "turn_context") {
      if (typeof p.cwd === "string") cwd = p.cwd; // cwd can change per turn
      if (typeof p.model === "string") model = p.model;
      continue;
    }
    if (e.type === "event_msg") {
      // Mirror events are otherwise ignored, but token_count is the only place
      // Codex reports usage.
      if (p.type === "token_count" && p.info && typeof p.info === "object") {
        const t = (p.info as any).total_token_usage;
        if (t && typeof t === "object") {
          const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          const cur = { input: n(t.input_tokens), cached: n(t.cached_input_tokens), output: n(t.output_tokens) };
          const d = {
            input: Math.max(0, cur.input - prevTotals.input),
            cached: Math.max(0, cur.cached - prevTotals.cached),
            output: Math.max(0, cur.output - prevTotals.output),
          };
          prevTotals = cur;
          if (d.input + d.cached + d.output > 0) {
            events.push({
              kind: "meta",
              ts,
              cwd: cwd ?? undefined,
              model: model ?? undefined,
              usage: {
                input: Math.max(0, d.input - d.cached),
                output: d.output,
                cacheRead: d.cached,
                cacheWrite: 0,
              },
            });
          }
        }
      }
      continue;
    }
    if (e.type !== "response_item") continue;

    if (p.type === "message") {
      const role = p.role;
      if (role !== "user" && role !== "assistant") continue;
      const raw = contentText(p.content);
      const text = role === "user" ? cleanUserText(raw) : raw.trim();
      if (text) {
        events.push({ kind: role === "user" ? "user" : "assistant", ts, text, cwd: cwd ?? undefined });
      }
    } else if (p.type === "reasoning") {
      const text = summaryText(p.summary);
      if (text) events.push({ kind: "reasoning", ts, text, cwd: cwd ?? undefined });
    } else if (p.type === "function_call") {
      events.push({
        kind: "tool_call",
        ts,
        toolName: typeof p.name === "string" ? p.name : undefined,
        toolSummary: summarizeTool(p.name, p.arguments),
        cwd: cwd ?? undefined,
      });
    } else if (p.type === "function_call_output") {
      // Raw output stays dropped; the error bit is a metric.
      events.push({ kind: "tool_result", ts, cwd: cwd ?? undefined, isError: outputIsError(p.output) });
    }
  }

  return { tool: "codex", sessionId, cwd, events };
}
