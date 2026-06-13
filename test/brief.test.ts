import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBrief, shouldShowBrief, type InsightsCache } from "../src/brief.js";
import { computeInsights } from "../src/insights.js";
import type { MetricsRow } from "../src/db.js";

function row(over: Partial<MetricsRow>): MetricsRow {
  return {
    id: "s1:0",
    session_id: "s1",
    author: "alice",
    tool: "claude",
    repo: "proj",
    exchange_index: 0,
    ts: new Date(Date.now() - 3_600_000).toISOString(),
    ended_at: new Date(Date.now() - 3_540_000).toISOString(),
    think_ms: 30_000,
    work_ms: 60_000,
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    tool_calls: 1,
    file_reads: 1,
    file_edits: 0,
    errors: 0,
    interrupted: false,
    is_correction: false,
    model: null,
    ...over,
  };
}

function cache(dayRows: MetricsRow[], weekRows: MetricsRow[]): InsightsCache {
  return {
    updatedAt: new Date().toISOString(),
    author: "alice",
    day: computeInsights(dayRows, { author: "alice" }),
    week: computeInsights(weekRows, { author: "alice" }),
  };
}

test("shouldShowBrief: session always (default), daily once per local day, off never", () => {
  const now = new Date("2026-06-12T15:00:00").getTime();
  const earlierToday = new Date("2026-06-12T08:00:00").getTime();
  const yesterday = new Date("2026-06-11T23:00:00").getTime();

  assert.equal(shouldShowBrief("daily", null, now), true, "no marker → show");
  assert.equal(shouldShowBrief("daily", yesterday, now), true, "last shown yesterday → show");
  assert.equal(shouldShowBrief("daily", earlierToday, now), false, "already shown today → quiet");
  assert.equal(shouldShowBrief(undefined, earlierToday, now), true, "default is every session");
  assert.equal(shouldShowBrief("session", earlierToday, now), true);
  assert.equal(shouldShowBrief("off", null, now), false);
});

test("formatBrief: day + week lines, day line dropped when quiet today", () => {
  const r = row({});
  const both = formatBrief(cache([r], [r]))!;
  assert.ok(both.startsWith("Oh — last 24h:"));
  assert.ok(both.includes("Week:"));
  assert.equal(both.split("\n").length, 2, "two lines without a last-snippet");
  assert.ok(both.includes("oh insights"), "points at the full report");

  const weekOnly = formatBrief(cache([], [r]))!;
  assert.ok(!weekOnly.includes("last 24h"), "no day line when nothing happened today");
  assert.ok(weekOnly.includes("Week:"));
});

test('formatBrief: leads with what you were last working on, verbatim', () => {
  const r = row({});
  const c = cache([r], [r]);
  c.last = { snippet: "fix the hosted invite codes", repo: "Oh", ts: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  const msg = formatBrief(c, Date.now())!;
  const first = msg.split("\n")[0]!;
  assert.ok(first.startsWith('Last on: "fix the hosted invite codes"'), first);
  assert.ok(first.includes("Oh · 2h ago"), first);
  assert.equal(msg.split("\n").length, 3, "three lines with the last-snippet");
});

test("lastSnippet strips the User: prefix and truncates long prompts", async () => {
  const { lastSnippet } = await import("../src/brief.js");
  assert.equal(lastSnippet("User: why is the sky blue?\n\nAssistant: …"), "why is the sky blue?");
  const long = "User: " + "x".repeat(200);
  assert.equal(lastSnippet(long).length, 90);
  assert.ok(lastSnippet(long).endsWith("…"));
});

test("formatBrief: surfaces rabbit holes, returns null on an empty week", () => {
  const holes = [
    row({ id: "s1:0", exchange_index: 0, is_correction: true }),
    row({ id: "s1:1", exchange_index: 1, is_correction: true }),
    row({ id: "s1:2", exchange_index: 2, is_correction: true }),
    row({ id: "s1:3", exchange_index: 3, is_correction: true }),
  ];
  const msg = formatBrief(cache(holes, holes))!;
  assert.ok(msg.includes("1 rabbit hole"), "rabbit holes make the brief");

  assert.equal(formatBrief(cache([], [])), null, "empty week → stay silent");
});
