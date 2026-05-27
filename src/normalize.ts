// Group common events into Exchanges. An Exchange opens at each human prompt
// and gathers the assistant work (replies, reasoning, tool actions) that
// answers it, up to the next human prompt. The assembled `reasoningText` is
// what we embed; raw tool output and file dumps never reach this layer.

import { basename } from "node:path";
import type { Exchange, ParsedEvent, ParseResult } from "./types.js";

export function repoFromCwd(cwd: string | null | undefined): string {
  if (!cwd) return "unknown";
  const name = basename(cwd.replace(/[/\\]+$/, ""));
  return name || "unknown";
}

interface Group {
  events: ParsedEvent[];
  ts: string;
  cwd: string;
}

function buildReasoningText(group: Group, includeThinking: boolean): {
  text: string;
  toolSummaries: string[];
} {
  let userText = "";
  const assistantParts: string[] = [];
  const toolSummaries: string[] = [];

  for (const ev of group.events) {
    switch (ev.kind) {
      case "user":
        userText = ev.text ?? userText;
        break;
      case "assistant":
        if (ev.text) assistantParts.push(ev.text);
        break;
      case "reasoning":
        if (includeThinking && ev.text) assistantParts.push(ev.text);
        break;
      case "tool_call":
        if (ev.toolSummary) toolSummaries.push(ev.toolSummary);
        break;
      default:
        break;
    }
  }

  const parts: string[] = [];
  if (userText) parts.push(`User: ${userText}`);
  const assistant = assistantParts.filter(Boolean).join("\n\n");
  if (assistant) parts.push(`Assistant: ${assistant}`);
  if (toolSummaries.length > 0) {
    parts.push("Actions:\n" + toolSummaries.map((s) => `- ${s}`).join("\n"));
  }
  return { text: parts.join("\n\n"), toolSummaries };
}

/**
 * Convert a parsed session into Exchanges.
 * `sessionId` falls back to the parsed id; the caller (capture) supplies one
 * derived from the filename when the file itself lacks it.
 */
export function toExchanges(
  parsed: ParseResult,
  opts: { author: string; includeThinking?: boolean; sessionId?: string },
): Exchange[] {
  const sessionId = opts.sessionId ?? parsed.sessionId;
  if (!sessionId) return [];
  const includeThinking = opts.includeThinking ?? true;
  const fallbackCwd = parsed.cwd ?? "";

  const groups: Group[] = [];
  let cur: Group | null = null;
  for (const ev of parsed.events) {
    if (ev.kind === "user") {
      if (cur) groups.push(cur);
      cur = { events: [ev], ts: ev.ts, cwd: ev.cwd ?? fallbackCwd };
    } else if (cur) {
      cur.events.push(ev);
      if (ev.cwd && (!cur.cwd || cur.cwd === "unknown")) cur.cwd = ev.cwd;
    }
    // assistant work before the first human prompt is dropped
  }
  if (cur) groups.push(cur);

  const exchanges: Exchange[] = [];
  let index = 0;
  for (const group of groups) {
    const { text, toolSummaries } = buildReasoningText(group, includeThinking);
    if (!text.trim()) continue; // nothing embeddable (e.g. empty prompt)
    const cwd = group.cwd || fallbackCwd;
    exchanges.push({
      sessionId,
      tool: parsed.tool,
      author: opts.author,
      repo: repoFromCwd(cwd),
      cwd,
      index: index++,
      ts: group.ts,
      reasoningText: text,
      toolSummaries,
    });
  }
  return exchanges;
}
