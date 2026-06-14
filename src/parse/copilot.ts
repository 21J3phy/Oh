// Parse a GitHub Copilot session into common ParsedEvents.
//
// Copilot CLI records each session under ~/.copilot/session-state/<uuid>/ as an
// `events.jsonl` (one event per line) plus a `workspace.yaml`. Oh tails the same
// way it does Claude/Codex, so capture needs only this parser, no new infra
// (ADR 0011).
//
// VERIFIED CLI shape (copilot-agent 0.0.400): every line is an envelope
//   { type, data, id, timestamp, parentId }
// where `type` is dotted/namespaced ("session.start", "user.message",
// "session.model_change", "assistant.turn_start", …) and the real content hangs
// off `data`. Session id and cwd ride on the `session.start` event
// (`data.sessionId`, `data.context.cwd`) — the filename ("events") is useless as
// an id. The user's clean prompt is `data.content` (a sibling `transformedContent`
// carries Copilot's context-wrapped version, which we drop).
//
// PARTIALLY INFERRED: the assistant-message and tool-call/result event shapes
// aren't yet observed on disk (the only local session errored before the model
// replied). They're handled shape-tolerantly off the same `<ns>.<sub>` dotted
// convention; tighten when a real assistant/tool event is confirmed.
//
// We ALSO keep the older shape-tolerant paths (flat role/kind chat JSONL, and a
// single session object with a messages array) — they cover VS Code Copilot
// chatSessions and any future format drift. Degrade-to-nothing is the rule: an
// unrecognised file yields zero events, it never throws.

import type { ParsedEvent, ParseResult } from "../types.js";
import { firstLine, stripWrapperBlocks } from "./util.js";

// Copilot injects its own preamble/context the way the other tools do; strip
// the obvious wrappers so we keep the person's actual words.
const USER_WRAPPER_TAGS = [
  "system-reminder",
  "environment_context",
  "user_instructions",
  "context",
  "current_datetime",
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
  const m = o?.model ?? o?.modelId ?? o?.model_id ?? o?.newModel;
  return typeof m === "string" ? m : undefined;
}

/** Session-level ids accumulated as we scan (first non-empty wins). */
interface Ids {
  sessionId: string | null;
  cwd: string | null;
  summary: string | null;
}

/** Push a usage/meta event if `src` carries token counts in any known shape. */
function pushUsage(src: any, ts: string, events: ParsedEvent[], ctx: { model?: string }): void {
  const usage = src?.usage ?? src?.tokenUsage ?? src?.token_usage;
  if (!usage || typeof usage !== "object") return;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? usage.promptTokens);
  const output = n(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? usage.completionTokens);
  const cacheRead = n(usage.cache_read_input_tokens ?? usage.cacheReadTokens ?? usage.cached_tokens);
  if (input + output + cacheRead > 0) {
    events.push({ kind: "meta", ts, model: ctx.model, usage: { input, output, cacheRead, cacheWrite: 0 } });
  }
}

/** True for a Copilot CLI envelope: dotted `type` plus a `data` object. */
function isCliEnvelope(o: any): boolean {
  return !!o && typeof o.type === "string" && o.type.includes(".") && o.data != null && typeof o.data === "object";
}

/**
 * Handle one Copilot CLI envelope event ({type:"<ns>.<sub>", data}). Verified
 * for session/user events; tolerant for the not-yet-observed assistant/tool
 * shapes, dispatched off the dotted namespace.
 */
function handleCliEvent(type: string, data: any, ts: string, events: ParsedEvent[], ctx: { model?: string }): void {
  const dot = type.indexOf(".");
  const ns = dot === -1 ? type : type.slice(0, dot);
  const sub = dot === -1 ? "" : type.slice(dot + 1);

  // Model + token usage can ride on any event's data.
  const m = modelOf(data);
  if (m) ctx.model = m;
  pushUsage(data, ts, events, ctx);

  if (ns === "session") return; // start/info/model_change/error carry no reasoning text

  if (ns === "user") {
    const text = cleanUserText(contentText(data.content ?? data.text ?? data.message ?? data.prompt));
    if (text) events.push({ kind: "user", ts, text, ...(INTERRUPT_RE.test(text) ? { interrupted: true } : {}) });
    return;
  }

  if (ns === "tool") {
    if (sub.includes("result") || sub.includes("output") || sub.includes("return")) {
      events.push({ kind: "tool_result", ts, isError: outputIsError(data) });
      return;
    }
    const name = data.name ?? data.tool ?? data.tool_name ?? data.function?.name;
    events.push({
      kind: "tool_call",
      ts,
      toolName: typeof name === "string" ? name : undefined,
      toolSummary: summarizeTool(name, data.arguments ?? data.args ?? data.input ?? data.parameters ?? data.function?.arguments),
    });
    return;
  }

  if (ns === "assistant") {
    if (sub.includes("tool") || sub.includes("call")) {
      const name = data.name ?? data.tool ?? data.tool_name ?? data.function?.name;
      events.push({
        kind: "tool_call",
        ts,
        toolName: typeof name === "string" ? name : undefined,
        toolSummary: summarizeTool(name, data.arguments ?? data.args ?? data.input ?? data.parameters ?? data.function?.arguments),
      });
      return;
    }
    if (sub.includes("reason") || sub.includes("think")) {
      const text = contentText(data.content ?? data.text ?? data.summary ?? data.thinking).trim();
      if (text) events.push({ kind: "reasoning", ts, text });
      return;
    }
    // message / text / content / turn_* — emit only when there's real text.
    const text = contentText(data.content ?? data.text ?? data.message ?? data.response).trim();
    if (text) events.push({ kind: "assistant", ts, text, model: ctx.model });
    const calls = data.tool_calls ?? data.toolCalls;
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
}

/** Pull one logical event out of a flat (non-enveloped) record. */
function handleRecord(o: any, events: ParsedEvent[], ctx: { model?: string }): void {
  if (!o || typeof o !== "object") return;
  const ts = tsOf(o);
  const m = modelOf(o);
  if (m) ctx.model = m;

  const role = typeof o.role === "string" ? o.role.toLowerCase() : null;
  const kind = typeof o.type === "string" ? o.type.toLowerCase() : typeof o.kind === "string" ? o.kind.toLowerCase() : null;

  pushUsage(o, ts, events, ctx);

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

/** Route a record to the CLI-envelope handler or the flat handler. */
function dispatch(o: any, events: ParsedEvent[], ctx: { model?: string }): void {
  if (isCliEnvelope(o)) handleCliEvent(o.type.toLowerCase(), o.data, tsOf(o), events, ctx);
  else handleRecord(o.payload ?? o, events, ctx);
}

/** Probe a single object for session id / cwd / summary, first non-empty wins. */
function probeIds(s: any, ids: Ids, allowBareId: boolean): void {
  if (!s || typeof s !== "object") return;
  if (!ids.sessionId) {
    const v = s.sessionId ?? s.session_id ?? (allowBareId ? s.id : undefined);
    if (typeof v === "string") ids.sessionId = v;
  }
  if (!ids.cwd) {
    const v = s.cwd ?? s.workdir ?? s.workingDirectory ?? s.working_directory ?? s.repoPath ?? s.directory;
    if (typeof v === "string") ids.cwd = v;
  }
  if (!ids.summary) {
    const v = s.title ?? s.summary ?? s.name;
    if (typeof v === "string" && v.trim()) ids.summary = v.trim();
  }
}

/**
 * Capture ids from a record. For CLI envelopes the id/cwd live on
 * `data` / `data.context` and the envelope's own `id` is an EVENT id (never the
 * session id), so bare `id` is only trusted for flat records.
 */
function captureIds(o: any, ids: Ids): void {
  if (isCliEnvelope(o)) {
    probeIds(o.data, ids, false);
    probeIds(o.data.context, ids, false);
  } else {
    probeIds(o, ids, true);
    probeIds(o.meta ?? o.session ?? o.metadata, ids, true);
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
  const ids: Ids = { sessionId: null, cwd: null, summary: null };

  const trimmed = content.trim();
  if (!trimmed) return { tool: "copilot", ...ids, events };

  // Shape A: a single JSON object (a whole session in one file — VS Code-style).
  if (trimmed.startsWith("{")) {
    try {
      const root = JSON.parse(trimmed);
      // A single-object session is never a per-line CLI envelope; trust bare id.
      probeIds(root, ids, true);
      probeIds(root.meta ?? root.session ?? root.metadata, ids, true);
      const msgs = messagesFrom(root);
      if (msgs) {
        for (const m of msgs) dispatch(m, events, ctx);
        return { tool: "copilot", ...ids, events };
      }
      // Object with no recognised array — fall through to a per-line scan in
      // case it's actually JSONL whose first line happens to be an object.
    } catch {
      // not a single JSON object — try JSONL
    }
  }

  // Shape B: JSONL — one event per line (Copilot CLI events.jsonl).
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    captureIds(o, ids);
    dispatch(o, events, ctx);
  }

  return { tool: "copilot", ...ids, events };
}
