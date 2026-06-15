import { test } from "node:test";
import assert from "node:assert/strict";
import { toExchanges, repoFromCwd, shortRepo } from "../src/normalize.js";
import type { ParseResult } from "../src/types.js";

function fixture(): ParseResult {
  return {
    tool: "claude",
    sessionId: "sess-1",
    cwd: "/Users/x/worktrees/my-project",
    events: [
      // assistant event before any human prompt — must be dropped
      { kind: "assistant", ts: "2026-05-01T00:00:00Z", text: "stray preamble" },
      { kind: "user", ts: "2026-05-01T00:01:00Z", text: "why gRPC over REST?" },
      { kind: "reasoning", ts: "2026-05-01T00:01:05Z", text: "weighing latency vs simplicity" },
      { kind: "assistant", ts: "2026-05-01T00:01:10Z", text: "Going with gRPC for streaming." },
      { kind: "tool_call", ts: "2026-05-01T00:01:20Z", toolName: "Edit", toolSummary: "Edit: api/server.ts" },
      { kind: "user", ts: "2026-05-01T00:05:00Z", text: "add a healthcheck" },
      { kind: "assistant", ts: "2026-05-01T00:05:10Z", text: "Added /healthz." },
    ],
  };
}

test("groups events into one exchange per human prompt", () => {
  const exchanges = toExchanges(fixture(), { author: "alice" });
  assert.equal(exchanges.length, 2);
  assert.deepEqual(exchanges.map((e) => e.index), [0, 1]);
  assert.equal(exchanges[0]!.author, "alice");
  assert.equal(exchanges[0]!.repo, "my-project");
  assert.equal(exchanges[0]!.ts, "2026-05-01T00:01:00Z", "ts is the human prompt's time");
});

test("reasoning text carries prompt, explanation, and tool actions; drops stray preamble", () => {
  const [first] = toExchanges(fixture(), { author: "alice", includeThinking: true });
  assert.ok(first!.reasoningText.startsWith("User: why gRPC over REST?"));
  assert.ok(first!.reasoningText.includes("Going with gRPC for streaming."));
  assert.ok(first!.reasoningText.includes("weighing latency vs simplicity"), "thinking included");
  assert.ok(first!.reasoningText.includes("Actions:\n- Edit: api/server.ts"));
  assert.ok(!first!.reasoningText.includes("stray preamble"), "pre-prompt assistant text dropped");
  assert.deepEqual(first!.toolSummaries, ["Edit: api/server.ts"]);
});

test("includeThinking=false omits reasoning blocks", () => {
  const [first] = toExchanges(fixture(), { author: "alice", includeThinking: false });
  assert.ok(!first!.reasoningText.includes("weighing latency vs simplicity"));
  assert.ok(first!.reasoningText.includes("Going with gRPC for streaming."));
});

test("repoFromCwd uses the basename and tolerates trailing slashes / empties", () => {
  assert.equal(repoFromCwd("/a/b/scientific-raisin"), "scientific-raisin");
  assert.equal(repoFromCwd("/a/b/scientific-raisin/"), "scientific-raisin");
  assert.equal(repoFromCwd(""), "unknown");
  assert.equal(repoFromCwd(null), "unknown");
});

test("shortRepo labels a git-remote identity by its last segment", () => {
  assert.equal(shortRepo("github.com/21j3phy/aydhi"), "aydhi");
  assert.equal(shortRepo("aydhi"), "aydhi", "a basename fallback is returned as-is");
  assert.equal(shortRepo(null), "?");
  assert.equal(shortRepo(""), "?");
});

test("returns nothing when there is no human prompt", () => {
  const parsed: ParseResult = {
    tool: "codex",
    sessionId: "s2",
    cwd: "/x",
    events: [{ kind: "assistant", ts: "2026-05-01T00:00:00Z", text: "hi" }],
  };
  assert.equal(toExchanges(parsed, { author: "bob" }).length, 0);
});
