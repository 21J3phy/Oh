// Parse a Claude Code transcript (.jsonl) into common ParsedEvents.
//
// Layout (verified against real files): one JSON event per line, each carrying
// top-level `timestamp`, `cwd`, `sessionId`. We keep the reasoning — human
// prompts (string `user` content), assistant `text`/`thinking` blocks, and
// one-line summaries of `tool_use` blocks — and drop everything else:
//   - `user` events whose content is a list of `tool_result` blocks (raw output)
//   - `isMeta` / `isSidechain` events (injected context, sub-agent threads)
//   - attachment / last-prompt / ai-title / permission-mode / file-history-snapshot

import type { ParsedEvent, ParseResult } from "../types.js";
import { firstLine, stripWrapperBlocks } from "./util.js";

const USER_WRAPPER_TAGS = [
  "system-reminder",
  "local-command-stdout",
  "local-command-caveat",
  "command-name",
  "command-message",
  "command-args",
  "command-contents",
];

function cleanUserText(s: string): string {
  return stripWrapperBlocks(s, USER_WRAPPER_TAGS);
}

function summarizeTool(name: unknown, input: unknown): string {
  const n = typeof name === "string" && name ? name : "tool";
  if (!input || typeof input !== "object") return n;
  const i = input as Record<string, unknown>;
  switch (n) {
    case "Bash":
      return `Bash: ${firstLine(i["command"])}`;
    case "Read":
      return `Read: ${firstLine(i["file_path"])}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `${n}: ${firstLine(i["file_path"] ?? i["notebook_path"])}`;
    case "Glob":
      return `Glob: ${firstLine(i["pattern"])}`;
    case "Grep":
      return `Grep: ${firstLine(i["pattern"])}`;
    case "Task":
      return `Task: ${firstLine(i["description"] ?? i["subagent_type"])}`;
    case "WebFetch":
      return `WebFetch: ${firstLine(i["url"])}`;
    case "WebSearch":
      return `WebSearch: ${firstLine(i["query"])}`;
    default: {
      const hint =
        i["file_path"] ?? i["path"] ?? i["pattern"] ?? i["query"] ?? i["command"] ?? i["url"];
      return hint != null && hint !== "" ? `${n}: ${firstLine(hint)}` : n;
    }
  }
}

/** Claude repeats the same message.usage on every line of a multi-block
 *  assistant message — count each API message's usage once. */
function usageFrom(message: any, seenIds: Set<string>): { usage?: ParsedEvent["usage"]; model?: string } {
  const u = message?.usage;
  const id = typeof message?.id === "string" ? message.id : null;
  const model = typeof message?.model === "string" ? message.model : undefined;
  if (!u || typeof u !== "object" || (id && seenIds.has(id))) return { model };
  if (id) seenIds.add(id);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    model,
    usage: {
      input: n(u.input_tokens),
      output: n(u.output_tokens),
      cacheRead: n(u.cache_read_input_tokens),
      cacheWrite: n(u.cache_creation_input_tokens),
    },
  };
}

const INTERRUPT_RE = /^\[Request interrupted/i;

export function parseClaude(content: string): ParseResult {
  const events: ParsedEvent[] = [];
  const seenUsageIds = new Set<string>();
  let sessionId: string | null = null;
  let cwd: string | null = null;

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof e.sessionId === "string" && !sessionId) sessionId = e.sessionId;
    const ts: string =
      typeof e.timestamp === "string" ? e.timestamp : new Date(0).toISOString();
    const evCwd: string | undefined = typeof e.cwd === "string" ? e.cwd : undefined;

    if (e.type === "user") {
      if (e.isMeta || e.isSidechain) continue;
      const c = e.message?.content;
      if (typeof c === "string") {
        const text = cleanUserText(c);
        if (text) {
          if (evCwd && !cwd) cwd = evCwd;
          events.push({
            kind: "user",
            ts,
            text,
            cwd: evCwd,
            ...(INTERRUPT_RE.test(text) ? { interrupted: true } : {}),
          });
        }
      } else if (Array.isArray(c)) {
        // tool_result blocks — raw output stays dropped, but the error bit is a metric
        for (const b of c) {
          if (b && typeof b === "object" && b.type === "tool_result") {
            events.push({ kind: "tool_result", ts, cwd: evCwd, isError: b.is_error === true });
          }
        }
      }
    } else if (e.type === "assistant") {
      if (e.isSidechain) continue;
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) continue;
      if (evCwd && !cwd) cwd = evCwd;
      const { usage, model } = usageFrom(e.message, seenUsageIds);
      if (usage) events.push({ kind: "meta", ts, cwd: evCwd, usage, model });
      for (const b of blocks) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          events.push({ kind: "assistant", ts, text: b.text.trim(), cwd: evCwd, model });
        } else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) {
          events.push({ kind: "reasoning", ts, text: b.thinking.trim(), cwd: evCwd });
        } else if (b.type === "tool_use") {
          events.push({
            kind: "tool_call",
            ts,
            toolName: typeof b.name === "string" ? b.name : undefined,
            toolSummary: summarizeTool(b.name, b.input),
            cwd: evCwd,
          });
        }
      }
    }
  }

  return { tool: "claude", sessionId, cwd, events };
}
