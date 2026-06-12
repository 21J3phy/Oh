// Group common events into Exchanges. An Exchange opens at each human prompt
// and gathers the assistant work (replies, reasoning, tool actions) that
// answers it, up to the next human prompt. The assembled `reasoningText` is
// what we embed; raw tool output and file dumps never reach this layer.

import { basename } from "node:path";
import type { Exchange, ExchangeMetrics, ParsedEvent, ParseResult } from "./types.js";

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

/** Prompts that read as corrections of the previous turn — a rabbit-hole signal. */
const CORRECTION_RE =
  /^(no\b|nope\b|wait\b|stop\b|wrong\b|actually\b|that'?s not|not what i)|still (failing|broken|not working|wrong|the same)|(doesn'?t|didn'?t|does not|did not) work|same (error|issue|problem)|not fixed/i;

const READ_TOOLS = new Set(["Read", "Glob", "Grep", "read_file", "list_dir", "grep"]);
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "edit_file", "write_file"]);

function classifyTool(name: string | undefined): "read" | "edit" | "other" {
  if (!name) return "other";
  if (READ_TOOLS.has(name)) return "read";
  if (EDIT_TOOLS.has(name) || /patch|write|edit/i.test(name)) return "edit";
  return "other";
}

function ms(ts: string): number {
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

/** Mechanical facts about one exchange (ADR 0007). `prevEndTs` = last event of
 *  the previous exchange, for the think-time gap. */
function buildMetrics(group: Group, prevEndTs: string | null): ExchangeMetrics {
  const m: ExchangeMetrics = {
    endedAt: group.ts,
    thinkMs: null,
    workMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    toolCalls: 0,
    fileReads: 0,
    fileEdits: 0,
    errors: 0,
    interrupted: false,
    isCorrection: false,
    model: null,
  };

  for (const ev of group.events) {
    if (ms(ev.ts) > ms(m.endedAt)) m.endedAt = ev.ts;
    if (ev.model) m.model = ev.model;
    if (ev.usage) {
      m.inputTokens += ev.usage.input;
      m.outputTokens += ev.usage.output;
      m.cacheReadTokens += ev.usage.cacheRead;
      m.cacheWriteTokens += ev.usage.cacheWrite;
    }
    switch (ev.kind) {
      case "user":
        if (ev.interrupted) m.interrupted = true;
        else if (ev.text && CORRECTION_RE.test(ev.text)) m.isCorrection = true;
        break;
      case "tool_call": {
        m.toolCalls++;
        const cls = classifyTool(ev.toolName);
        if (cls === "read") m.fileReads++;
        else if (cls === "edit") m.fileEdits++;
        break;
      }
      case "tool_result":
        if (ev.isError) m.errors++;
        break;
      default:
        break;
    }
  }

  m.workMs = Math.max(0, ms(m.endedAt) - ms(group.ts));
  if (prevEndTs) m.thinkMs = Math.max(0, ms(group.ts) - ms(prevEndTs));
  return m;
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
  let prevEndTs: string | null = null;
  for (const group of groups) {
    const metrics = buildMetrics(group, prevEndTs);
    prevEndTs = metrics.endedAt; // skipped groups still anchor the next think-gap
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
      metrics,
    });
  }
  return exchanges;
}
