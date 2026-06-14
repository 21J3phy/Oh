import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCopilot } from "../src/parse/copilot.js";
import { toExchanges } from "../src/normalize.js";

// Two fixture families:
//  - REAL_CLI_SESSION encodes the VERIFIED Copilot CLI envelope (copilot-agent
//    0.0.400): {type:"<ns>.<sub>", data, id, timestamp, parentId}, ids on the
//    session.start event, clean prompt in data.content. The assistant/tool
//    events here follow the same dotted convention but are inferred (no
//    successful turn was on disk to copy) — tighten if a real one differs.
//  - JSONL_SESSION / OBJECT_SESSION keep the older flat shapes the parser stays
//    tolerant to (VS Code chatSessions, format drift).

const JSONL_SESSION = [
  { timestamp: "2026-06-14T01:00:00Z", sessionId: "cop-1", cwd: "/home/u/proj", role: "user", content: "Why did we pick Redis?" },
  { timestamp: "2026-06-14T01:00:05Z", role: "assistant", content: "We picked Redis for latency.", model: "gpt-5", usage: { input_tokens: 10, output_tokens: 20 } },
  { timestamp: "2026-06-14T01:00:06Z", type: "tool_call", name: "Bash", arguments: { command: "redis-cli ping" } },
  { timestamp: "2026-06-14T01:00:07Z", type: "tool_result", exit_code: 0 },
  { timestamp: "2026-06-14T01:01:00Z", role: "user", content: "thanks" },
  { timestamp: "2026-06-14T01:01:02Z", role: "assistant", content: "np" },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

const OBJECT_SESSION = JSON.stringify({
  id: "cop-2",
  workdir: "/home/u/proj",
  title: "Redis migration",
  messages: [
    { role: "user", content: [{ type: "text", text: "Migrate the cache to Redis" }], timestamp: "2026-06-14T02:00:00Z" },
    {
      role: "assistant",
      content: "On it.",
      timestamp: "2026-06-14T02:00:01Z",
      tool_calls: [{ function: { name: "Edit", arguments: '{"file_path":"src/db.ts"}' } }],
    },
    { type: "tool_result", timestamp: "2026-06-14T02:00:02Z", isError: true },
  ],
});

// Verified envelope: every line is {type, data, id, timestamp, parentId}; the
// session id + cwd live on session.start.data; the clean prompt is data.content
// (data.transformedContent carries Copilot's context-wrapped copy, which we drop).
const REAL_CLI_SESSION = [
  {
    type: "session.start",
    data: { sessionId: "ef23-real", version: 1, producer: "copilot-agent", context: { cwd: "/Users/u/aydhi", gitRoot: "/Users/u/aydhi", repository: "o/aydhi", branch: "main" } },
    id: "evt-1",
    timestamp: "2026-06-10T18:10:34Z",
  },
  { type: "session.model_change", data: { newModel: "claude-opus-4.5" }, id: "evt-2", timestamp: "2026-06-10T18:10:54Z", parentId: "evt-1" },
  {
    type: "user.message",
    data: {
      content: "Why did we pick Redis?",
      transformedContent: "<current_datetime>2026-06-10T18:11:31Z</current_datetime>\n\nWhy did we pick Redis?",
      attachments: [],
    },
    id: "evt-3",
    timestamp: "2026-06-10T18:11:31Z",
    parentId: "evt-2",
  },
  // Inferred assistant/tool shapes (same dotted convention, content under data).
  { type: "assistant.message", data: { content: "We picked Redis for latency.", usage: { input_tokens: 12, output_tokens: 8 } }, id: "evt-4", timestamp: "2026-06-10T18:11:40Z", parentId: "evt-3" },
  { type: "assistant.tool_call", data: { name: "bash", arguments: { command: "redis-cli ping" } }, id: "evt-5", timestamp: "2026-06-10T18:11:41Z", parentId: "evt-4" },
  { type: "tool.result", data: { exit_code: 0 }, id: "evt-6", timestamp: "2026-06-10T18:11:42Z", parentId: "evt-5" },
]
  .map((e) => JSON.stringify(e))
  .join("\n");

test("copilot: parses the real CLI envelope (type/data, dotted kinds)", () => {
  const r = parseCopilot(REAL_CLI_SESSION);
  assert.equal(r.tool, "copilot");
  // ids come off session.start.data, NOT the envelope's per-event `id`.
  assert.equal(r.sessionId, "ef23-real");
  assert.equal(r.cwd, "/Users/u/aydhi");

  const user = r.events.find((e) => e.kind === "user")!;
  assert.equal(user.text, "Why did we pick Redis?", "uses clean data.content, strips the datetime wrapper");

  const assistant = r.events.find((e) => e.kind === "assistant")!;
  assert.equal(assistant.text, "We picked Redis for latency.");
  assert.equal(assistant.model, "claude-opus-4.5", "model carried from session.model_change");

  const call = r.events.find((e) => e.kind === "tool_call")!;
  assert.equal(call.toolSummary, "bash: redis-cli ping");
  const res = r.events.find((e) => e.kind === "tool_result")!;
  assert.equal(res.isError, false);

  const meta = r.events.find((e) => e.kind === "meta");
  assert.equal(meta?.usage?.input, 12);
  assert.equal(meta?.usage?.output, 8);
});

test("copilot: real envelope yields well-formed exchanges", () => {
  const exchanges = toExchanges(parseCopilot(REAL_CLI_SESSION), { author: "tester", sessionId: "ef23-real" });
  assert.ok(exchanges.length >= 1);
  assert.ok(exchanges.every((ex) => ex.tool === "copilot"));
  assert.ok(exchanges[0]!.reasoningText.includes("Why did we pick Redis?"), "prompt folded in");
  assert.ok(exchanges[0]!.reasoningText.includes("bash: redis-cli ping"), "tool action folded in");
});

test("copilot: parses JSONL chat sessions", () => {
  const r = parseCopilot(JSONL_SESSION);
  assert.equal(r.tool, "copilot");
  assert.equal(r.sessionId, "cop-1");
  assert.equal(r.cwd, "/home/u/proj");

  const kinds = r.events.map((e) => e.kind);
  assert.ok(kinds.includes("user"), "has a user event");
  assert.ok(kinds.includes("assistant"), "has an assistant event");
  assert.ok(kinds.includes("tool_call"), "has a tool_call");
  assert.ok(kinds.includes("tool_result"), "has a tool_result");

  const call = r.events.find((e) => e.kind === "tool_call")!;
  assert.equal(call.toolSummary, "Bash: redis-cli ping");

  const meta = r.events.find((e) => e.kind === "meta");
  assert.equal(meta?.usage?.input, 10);
  assert.equal(meta?.usage?.output, 20);
});

test("copilot: parses a single-object session with nested tool_calls", () => {
  const r = parseCopilot(OBJECT_SESSION);
  assert.equal(r.sessionId, "cop-2");
  assert.equal(r.cwd, "/home/u/proj");
  assert.equal(r.summary, "Redis migration");

  const call = r.events.find((e) => e.kind === "tool_call")!;
  assert.equal(call.toolSummary, "Edit: src/db.ts");
  const res = r.events.find((e) => e.kind === "tool_result")!;
  assert.equal(res.isError, true);
});

test("copilot: produces well-formed exchanges", () => {
  const exchanges = toExchanges(parseCopilot(JSONL_SESSION), { author: "tester" });
  assert.ok(exchanges.length >= 1);
  exchanges.forEach((ex, i) => assert.equal(ex.index, i, "indices contiguous"));
  assert.ok(exchanges.every((ex) => ex.tool === "copilot"));
  assert.ok(exchanges[0]!.reasoningText.startsWith("User:"), "first exchange carries the prompt");
  assert.ok(exchanges[0]!.reasoningText.includes("Bash: redis-cli ping"), "tool action folded in");
  for (const ex of exchanges) {
    for (const s of ex.toolSummaries) assert.ok(!s.includes("\n"), "tool summary is one line");
  }
});

test("copilot: errors and tokens land in metrics", () => {
  const jsonl = toExchanges(parseCopilot(JSONL_SESSION), { author: "t" });
  const tokens = jsonl.reduce((a, ex) => a + ex.metrics.inputTokens + ex.metrics.outputTokens, 0);
  assert.equal(tokens, 30, "token usage summed across exchanges");

  const obj = toExchanges(parseCopilot(OBJECT_SESSION), { author: "t" });
  assert.equal(obj.reduce((a, ex) => a + ex.metrics.errors, 0), 1, "tool error counted");
});

test("copilot: garbage and empty input degrade to nothing, never throw", () => {
  assert.equal(parseCopilot("").events.length, 0);
  assert.equal(parseCopilot("not json\n{bad").events.length, 0);
  assert.equal(parseCopilot("{}").events.length, 0);
});

test("copilot: detects interrupt markers", () => {
  const r = parseCopilot(JSON.stringify({ role: "user", content: "[Request interrupted by user]" }));
  assert.equal(r.events[0]?.interrupted, true);
});
