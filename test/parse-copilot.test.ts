import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCopilot } from "../src/parse/copilot.js";
import { toExchanges } from "../src/normalize.js";

// NOTE: Copilot CLI's on-disk schema isn't publicly specced, so these fixtures
// encode the *documented* shapes (chat-style JSONL and a single session object)
// the shape-tolerant parser targets. Re-verify against a real
// ~/.copilot/session-state/ file when one is available (ADR 0011).

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
