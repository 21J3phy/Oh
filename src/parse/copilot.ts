// Parse a GitHub Copilot CLI session into common ParsedEvents.
//
// Copilot CLI records session data locally under ~/.copilot/session-state/
// (prompts, the model's responses, the tools used, and files modified) — the
// same shape Oh already tails for Claude and Codex, so capture needs only this
// parser, no new infrastructure (ADR 0011).
//
// IMPORTANT: unlike claude.ts / codex.ts, this parser is written against the
// *documented* behaviour of Copilot CLI, not yet verified line-by-line against
// real files (Copilot's on-disk schema is not publicly specced and has shifted
// between releases). It is therefore deliberately *shape-tolerant*: it accepts
// either a single JSON object with a messages/turns/events array, or JSONL with
// one event per line, and probes a few common field names for each. When the
// real format is confirmed, tighten this the way the other parsers are.
// Degrade-to-nothing is the rule — an unrecognised file yields zero events, it
// never throws.

import type { ParsedEvent, ParseResult } from "../types.js";
import { firstLine, stripWrapperBlocks } from "./util.js";

// Copilot CLI injects its own preamble/context the way the other tools do; strip
// the obvious wrappers so we keep the person's actual words.
const USER_WRAPPER_TAGS = [
  "system-reminder",
  "environment_context",
  "user_instructions",
  "context",
];

function cleanUserText(s: string): string {
  return stripWrapperBlocks(s, USER_WRAPPER_TAGS);
}

/** Flatten string | {text} | [{text|content}] | {content:…} into plain text. */
function contentText(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") return typeof b.text === "string" ? b.text : contentText(b.content);
        return "";
      })
      .join("\n")
      .trim();
  }
  if (typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (o.content != null) return contentText(o.content);
  }
  return "";
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
  const cmd = args["command"] ?? args["cmd"];
  if (Array.isArray(cmd)) return `${n}: ${firstLine(cmd.join(" "))}`;
  if (typeof cmd === "string" && cmd) return `${n}: ${firstLine(cmd)}`;
  const path = args["file_path"] ?? args["path"] ?? args["filePath"] ?? args["workdir"];
  if (typeof path === "string" && path) return `${n}: ${firstLine(path)}`;
  const hint = args["pattern"] ?? args["query"] ?? args["url"];
  if (typeof hint === "string" && hint) return `${n}: ${firstLine(hint)}`;
  if (typeof args["patch"] === "string") return `${n}: ${firstLine(args["patch"])}`;
  return n;
}

/** Tool outputs embed an error flag or non-zero exit in a few shapes. */
function outputIsError(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  if (item.is_error === true || item.isError === true || item.error === true) return true;
  for (const k of ["exit_code", "exitCode", "status", "code"]) {
    const v = item[k];
    if (typeof v === "number" && v !== 0) return true;
  }
  const out = item.output ?? item.result ?? item.content;
  if (typeof out === "string") {
    const m = out.match(/"exit_code"\s*:\s*(-?\d+)/);
    if (m && m[1] !== "0") return true;
  }
  return false;
}

const INTERRUPT_RE = /^\[(?:request )?(?:interrupted|cancelled|canceled|aborted)/i;
const ROLE_USER = new Set(["user", "human"]);
const ROLE_ASSISTANT = new Set(["assistant", "model", "ai", "copilot"]);
const KIND_USER = new Set(["user", "user_message", "prompt", "message.user"]);
const KIND_ASSISTANT = new Set(["assistant", "assistant_message", "response", "model_response", "completion"]);
const KIND_REASONING = new Set(["reasoning", "thinking", "thought"]);
const KIND_TOOL_CALL = new Set(["tool_call", "tool_use", "function_call", "tool", "action"]);
const KIND_TOOL_RESULT = new Set(["tool_result", "function_call_output", "tool_output", "observation"]);

function tsOf(o: any): string {
  const raw = o?.timestamp ?? o?.ts ?? o?.time ?? o?.createdAt ?? o?.created_at;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return new Date(raw < 1e12 ? raw * 1000 : raw).toISOString();
  return new Date(0).toISOString();
}

function modelOf(o: any): string | undefined {
  const m = o?.model ?? o?.modelId ?? o?.model_id;
  return typeof m === "string" ? m : undefined;
}

/** Pull one logical event out of a record, appending to `events`. */
function handleRecord(o: any, events: ParsedEvent[], ctx: { model?: string }): void {
  if (!o || typeof o !== "object") return;
  const ts = tsOf(o);
  const m = modelOf(o);
  if (m) ctx.model = m;

  // Role-tagged messages (chat shape).
  const role = typeof o.role === "string" ? o.role.toLowerCase() : null;
  const kind = typeof o.type === "string" ? o.type.toLowerCase() : typeof o.kind === "string" ? o.kind.toLowerCase() : null;

  // Token usage, wherever it hangs.
  const usage = o.usage ?? o.tokenUsage ?? o.token_usage;
  if (usage && typeof usage === "object") {
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const input = n(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens);
    const output = n(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens);
    const cacheRead = n(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cached_tokens);
    if (input + output + cacheRead > 0) {
      events.push({ kind: "meta", ts, model: ctx.model, usage: { input, output, cacheRead, cacheWrite: 0 } });
    }
  }

  const isUser = (role && ROLE_USER.has(role)) || (kind && KIND_USER.has(kind));
  const isAssistant = (role && ROLE_ASSISTANT.has(role)) || (kind && KIND_ASSISTANT.has(kind));

  if (isUser) {
    const text = cleanUserText(contentText(o.content ?? o.text ?? o.message ?? o.prompt));
    if (text) events.push({ kind: "user", ts, text, ...(INTERRUPT_RE.test(text) ? { interrupted: true } : {}) });
    return;
  }
  if (isAssistant) {
    const text = contentText(o.content ?? o.text ?? o.message ?? o.response).trim();
    if (text) events.push({ kind: "assistant", ts, text, model: ctx.model });
    // Some shapes nest tool calls inside the assistant message.
    const calls = o.tool_calls ?? o.toolCalls;
    if (Array.isArray(calls)) {
      for (const c of calls) {
        const fn = c?.function ?? c;
        events.push({
          kind: "tool_call",
          ts,
          toolName: typeof fn?.name === "string" ? fn.name : undefined,
          toolSummary: summarizeTool(fn?.name, fn?.arguments ?? fn?.args ?? fn?.input ?? c?.input),
        });
      }
    }
    return;
  }
  if (kind && KIND_REASONING.has(kind)) {
    const text = contentText(o.content ?? o.text ?? o.summary ?? o.thinking).trim();
    if (text) events.push({ kind: "reasoning", ts, text });
    return;
  }
  if (kind && KIND_TOOL_CALL.has(kind)) {
    const name = o.name ?? o.tool ?? o.tool_name ?? o.function?.name;
    events.push({
      kind: "tool_call",
      ts,
      toolName: typeof name === "string" ? name : undefined,
      toolSummary: summarizeTool(name, o.arguments ?? o.args ?? o.input ?? o.parameters ?? o.function?.arguments),
    });
    return;
  }
  if (kind && KIND_TOOL_RESULT.has(kind)) {
    events.push({ kind: "tool_result", ts, isError: outputIsError(o) });
    return;
  }
}

/** Find the conversation array inside a top-level session object. */
function messagesFrom(root: any): any[] | null {
  for (const k of ["messages", "turns", "events", "history", "items", "entries", "conversation"]) {
    if (Array.isArray(root?.[k])) return root[k] as any[];
  }
  return null;
}

export function parseCopilot(content: string): ParseResult {
  const events: ParsedEvent[] = [];
  const ctx: { model?: string } = {};
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let summary: string | null = null;

  const trimmed = content.trim();
  if (!trimmed) return { tool: "copilot", sessionId, cwd, summary, events };

  const idFrom = (o: any) => {
    if (!sessionId) {
      const v = o?.sessionId ?? o?.session_id ?? o?.id;
      if (typeof v === "string") sessionId = v;
    }
    if (!cwd) {
      const v = o?.cwd ?? o?.workdir ?? o?.workingDirectory ?? o?.working_directory ?? o?.repoPath ?? o?.directory;
      if (typeof v === "string") cwd = v;
    }
    if (!summary) {
      const v = o?.title ?? o?.summary ?? o?.name;
      if (typeof v === "string" && v.trim()) summary = v.trim();
    }
  };

  // Shape A: a single JSON object (the whole session in one file).
  if (trimmed.startsWith("{")) {
    try {
      const root = JSON.parse(trimmed);
      idFrom(root);
      // Session-level metadata may also live on a nested meta object.
      idFrom(root.meta ?? root.session ?? root.metadata ?? {});
      const msgs = messagesFrom(root);
      if (msgs) {
        for (const m of msgs) handleRecord(m, events, ctx);
        return { tool: "copilot", sessionId, cwd, summary, events };
      }
      // Object with no recognised array — fall through to per-line scan in case
      // it's actually JSONL whose first line happens to be an object.
    } catch {
      // not a single JSON object — try JSONL
    }
  }

  // Shape B: JSONL — one event per line.
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    idFrom(o);
    // A line may itself be a {payload:…} envelope (Codex-style).
    handleRecord(o.payload ?? o, events, ctx);
  }

  return { tool: "copilot", sessionId, cwd, summary, events };
}
