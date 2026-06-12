import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaude } from "../src/parse/claude.js";
import { parseCodex } from "../src/parse/codex.js";
import { toExchanges } from "../src/normalize.js";
import {
  computeInsights,
  computeTeamInsights,
  countRabbitHoleEpisodes,
  detectRabbitHole,
  formatInsights,
  formatNudge,
  formatTeamInsights,
  RABBIT_HOLE_MIN_STREAK,
} from "../src/insights.js";
import type { MetricsRow } from "../src/db.js";

// --- parser metric extraction (real-shape synthetic lines) ------------------

function claudeFixture(): string {
  const lines = [
    { type: "user", sessionId: "s1", timestamp: "2026-05-01T00:00:00Z", cwd: "/x/proj", message: { content: "fix the bug" } },
    // one assistant API message split across two block lines — usage must count ONCE
    {
      type: "assistant", sessionId: "s1", timestamp: "2026-05-01T00:00:30Z", cwd: "/x/proj",
      message: { id: "msg_1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, content: [{ type: "text", text: "Looking." }] },
    },
    {
      type: "assistant", sessionId: "s1", timestamp: "2026-05-01T00:00:31Z", cwd: "/x/proj",
      message: { id: "msg_1", model: "claude-opus-4-8", usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }, content: [{ type: "tool_use", name: "Read", input: { file_path: "a.ts" } }] },
    },
    // tool result with an error
    { type: "user", sessionId: "s1", timestamp: "2026-05-01T00:00:40Z", cwd: "/x/proj", message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] } },
    {
      type: "assistant", sessionId: "s1", timestamp: "2026-05-01T00:01:00Z", cwd: "/x/proj",
      message: { id: "msg_2", model: "claude-opus-4-8", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: "text", text: "Fixed." }, { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] },
    },
    // interrupt marker
    { type: "user", sessionId: "s1", timestamp: "2026-05-01T00:02:00Z", cwd: "/x/proj", message: { content: "[Request interrupted by user]" } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

test("claude parser: usage deduped by message id, errors and interrupts tagged", () => {
  const parsed = parseClaude(claudeFixture());
  const usages = parsed.events.filter((e) => e.usage);
  assert.equal(usages.length, 2, "msg_1 usage counted once, msg_2 once");
  assert.equal(usages[0]!.usage!.input, 100);
  assert.equal(usages[0]!.usage!.cacheRead, 1000);
  assert.equal(usages[0]!.usage!.cacheWrite, 200);
  assert.equal(usages[0]!.model, "claude-opus-4-8");
  assert.equal(parsed.events.filter((e) => e.kind === "tool_result" && e.isError).length, 1);
  assert.equal(parsed.events.filter((e) => e.interrupted).length, 1);
});

function codexFixture(): string {
  const lines = [
    { timestamp: "2026-05-01T00:00:00Z", type: "session_meta", payload: { id: "c1", cwd: "/x/proj" } },
    { timestamp: "2026-05-01T00:00:01Z", type: "turn_context", payload: { cwd: "/x/proj", model: "gpt-5.1-codex" } },
    { timestamp: "2026-05-01T00:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "run the tests" }] } },
    // cumulative totals: input includes cached
    { timestamp: "2026-05-01T00:00:10Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 80, total_tokens: 1080 } } } },
    { timestamp: "2026-05-01T00:00:11Z", type: "response_item", payload: { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["npm", "test"] }) } },
    { timestamp: "2026-05-01T00:00:12Z", type: "response_item", payload: { type: "function_call_output", payload: null, output: JSON.stringify({ output: "fail", metadata: { exit_code: 1 } }) } },
    { timestamp: "2026-05-01T00:00:20Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "still failing, same error" }] } },
    // second cumulative reading — delta is 500 input (300 cached) / 40 output
    { timestamp: "2026-05-01T00:00:30Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 900, output_tokens: 120, total_tokens: 1620 } } } },
    // info:null variants must not crash or count
    { timestamp: "2026-05-01T00:00:31Z", type: "event_msg", payload: { type: "token_count", info: null } },
  ];
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

test("codex parser: cumulative token_count diffed into deltas, cached split out, exit codes flag errors", () => {
  const parsed = parseCodex(codexFixture());
  const usages = parsed.events.filter((e) => e.usage);
  assert.equal(usages.length, 2);
  // first reading: 1000 input of which 600 cached → 400 fresh input
  assert.deepEqual(usages[0]!.usage, { input: 400, output: 80, cacheRead: 600, cacheWrite: 0 });
  // delta: +500 input of which +300 cached → 200 fresh input, +40 output
  assert.deepEqual(usages[1]!.usage, { input: 200, output: 40, cacheRead: 300, cacheWrite: 0 });
  assert.equal(usages[0]!.model, "gpt-5.1-codex");
  assert.equal(parsed.events.filter((e) => e.kind === "tool_result" && e.isError).length, 1);
});

// --- normalize: per-exchange metrics ----------------------------------------

test("normalize: metrics carry durations, token sums, counts, and correction flags", () => {
  const parsed = parseCodex(codexFixture());
  const exchanges = toExchanges(parsed, { author: "alice" });
  assert.equal(exchanges.length, 2);

  const m0 = exchanges[0]!.metrics;
  assert.equal(m0.thinkMs, null, "first exchange has no think gap");
  assert.equal(m0.workMs, 10_000, "prompt at :02, last event at :12");
  assert.equal(m0.inputTokens, 400);
  assert.equal(m0.outputTokens, 80);
  assert.equal(m0.cacheReadTokens, 600);
  assert.equal(m0.toolCalls, 1);
  assert.equal(m0.errors, 1);
  assert.equal(m0.isCorrection, false);
  assert.equal(m0.model, "gpt-5.1-codex");

  const m1 = exchanges[1]!.metrics;
  assert.equal(m1.thinkMs, 8_000, "gap from :12 (prev end) to :20 (next prompt)");
  assert.equal(m1.isCorrection, true, '"still failing, same error" reads as a correction');
});

test("normalize: claude metrics count file edits and interrupts", () => {
  const exchanges = toExchanges(parseClaude(claudeFixture()), { author: "alice" });
  // exchange 0: "fix the bug"; exchange 1: the interrupt marker
  const m0 = exchanges[0]!.metrics;
  assert.equal(m0.fileReads, 1);
  assert.equal(m0.fileEdits, 1);
  assert.equal(m0.errors, 1);
  assert.equal(m0.inputTokens, 110, "both messages' input, deduped per message");
  assert.equal(m0.outputTokens, 55);
  assert.ok(exchanges.some((e) => e.metrics.interrupted), "interrupt marker tagged");
});

// --- rabbit-hole detector ----------------------------------------------------

const ok = { isCorrection: false, errors: 0, freshTokens: 1000 };
const bad = { isCorrection: true, errors: 0, freshTokens: 2000 };
const err = { isCorrection: false, errors: 2, freshTokens: 3000 };

test("detectRabbitHole fires only on a long-enough TRAILING streak", () => {
  assert.equal(detectRabbitHole([ok, bad, bad, bad]), null, "streak of 3 is not enough");
  assert.equal(detectRabbitHole([bad, bad, bad, bad, ok]), null, "streak must be trailing");
  const hit = detectRabbitHole([ok, bad, bad, err, bad]);
  assert.ok(hit);
  assert.equal(hit.streak, RABBIT_HOLE_MIN_STREAK);
  assert.equal(hit.tokens, 2000 + 2000 + 3000 + 2000);
});

test("countRabbitHoleEpisodes counts maximal runs once each", () => {
  assert.equal(countRabbitHoleEpisodes([bad, bad, bad, bad, bad, bad]), 1, "one long run = one episode");
  assert.equal(countRabbitHoleEpisodes([bad, bad, bad, bad, ok, err, err, err, err]), 2);
  assert.equal(countRabbitHoleEpisodes([bad, ok, bad, ok, bad]), 0);
});

test("formatNudge mentions the streak and the cost", () => {
  const msg = formatNudge(5, 80_000);
  assert.ok(msg.includes("5 turns"));
  assert.ok(msg.includes("80k tokens"));
});

// --- aggregation ---------------------------------------------------------------

function row(over: Partial<MetricsRow>): MetricsRow {
  return {
    id: "s1:0",
    session_id: "s1",
    author: "alice",
    tool: "claude",
    repo: "proj",
    exchange_index: 0,
    ts: "2026-05-01T10:00:00Z",
    ended_at: "2026-05-01T10:01:00Z",
    think_ms: null,
    work_ms: 60_000,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 900,
    cache_write_tokens: 0,
    tool_calls: 1,
    file_reads: 1,
    file_edits: 0,
    errors: 0,
    interrupted: false,
    is_correction: false,
    model: "claude-opus-4-8",
    ...over,
  };
}

test("computeInsights: time anatomy buckets think gaps and excludes long ones", () => {
  const rows = [
    row({ id: "s1:0", exchange_index: 0 }),
    row({ id: "s1:1", exchange_index: 1, ts: "2026-05-01T10:02:00Z", ended_at: "2026-05-01T10:03:00Z", think_ms: 60_000 }), // ≤5m → prompting
    row({ id: "s1:2", exchange_index: 2, ts: "2026-05-01T10:13:00Z", ended_at: "2026-05-01T10:14:00Z", think_ms: 600_000 }), // 10m → away
    row({ id: "s1:3", exchange_index: 3, ts: "2026-05-01T12:00:00Z", ended_at: "2026-05-01T12:01:00Z", think_ms: 6_360_000 }), // >30m → excluded
  ];
  const r = computeInsights(rows, { author: "alice", sinceIso: "2026-05-01T00:00:00Z" });
  assert.equal(r.exchanges, 4);
  assert.equal(r.sessions, 1);
  assert.equal(r.promptMs, 60_000);
  assert.equal(r.awayMs, 600_000);
  assert.equal(r.workMs, 240_000);
  assert.equal(r.cacheHitRate, (900 * 4) / (100 * 4 + 900 * 4));
  assert.ok(r.longestSession && r.longestSession.ms > 0);
  assert.equal(r.peakHour, new Date("2026-05-01T10:00:00Z").getHours());
});

test("computeInsights: friction, episodes, and the top exchange", () => {
  const rows = [
    row({ id: "s1:0", exchange_index: 0, is_correction: true }),
    row({ id: "s1:1", exchange_index: 1, errors: 3 }),
    row({ id: "s1:2", exchange_index: 2, is_correction: true }),
    row({ id: "s1:3", exchange_index: 3, is_correction: true, interrupted: true }),
    row({ id: "s1:4", exchange_index: 4, output_tokens: 9000 }),
  ];
  const r = computeInsights(rows, {});
  assert.equal(r.corrections, 3);
  assert.equal(r.errors, 3);
  assert.equal(r.interrupts, 1);
  assert.equal(r.rabbitHoleEpisodes, 1, "indices 0-3 form one episode");
  assert.equal(r.topExchange?.freshTokens, 100 + 9000);
});

test("formatters render without blowing up, including the empty case", () => {
  const empty = formatInsights(computeInsights([], { author: "alice" }));
  assert.ok(empty.includes("No captured exchanges"));
  const full = formatInsights(computeInsights([row({})], { author: "alice", sinceIso: "2026-05-01T00:00:00Z" }));
  assert.ok(full.includes("alice's vibecoding"));
  assert.ok(full.includes("agent working"));
  const team = formatTeamInsights(
    computeTeamInsights([row({}), row({ id: "s2:0", session_id: "s2", author: "bob" })], null),
    null,
  );
  assert.ok(team.includes("alice") && team.includes("bob"));
});
