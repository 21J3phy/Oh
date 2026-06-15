import { test } from "node:test";
import assert from "node:assert/strict";
import { formatBrief, formatTokenChart, shouldShowBrief, type DailyStat, type InsightsCache } from "../src/brief.js";
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
  assert.ok(both.startsWith("Oh ▸ today"), both);
  assert.ok(both.includes("week:"));
  assert.equal(both.split("\n").length, 1, "one line without a last-snippet or tip");
  assert.equal(both.split("Oh ▸").length, 2, "branded exactly once");

  const weekOnly = formatBrief(cache([], [r]))!;
  assert.ok(!weekOnly.includes("today"), "no day stats when nothing happened today");
  assert.ok(weekOnly.includes("week:"));
});

test('formatBrief: leads with what you were last working on, verbatim', () => {
  const r = row({});
  const c = cache([r], [r]);
  c.last = { snippet: "fix the hosted invite codes", repo: "Oh", ts: new Date(Date.now() - 2 * 3_600_000).toISOString() };
  const msg = formatBrief(c, Date.now())!;
  const first = msg.split("\n")[0]!;
  assert.ok(first.startsWith('Oh ▸ where you left off: "fix the hosted invite codes"'), first);
  assert.ok(first.includes("Oh · 2h ago"), first);
  assert.equal(msg.split("\n").length, 2, "header + stats, no tip set");
  c.tips = ["that ask cost a lot"];
  const withTip = formatBrief(c, Date.now())!;
  assert.equal(withTip.split("\n").length, 3, "header + stats + tip");
  assert.ok(withTip.includes("tip: that ask cost a lot"));
});

test("formatBrief: rotation index picks a different tip each render", () => {
  const r = row({});
  const c = cache([r], [r]);
  c.tips = ["tip A", "tip B", "tip C"];
  const tipOf = (msg: string) => msg.split("\n").find((l) => l.includes("tip:"));
  // Consecutive rotations cycle through every tip, then wrap.
  assert.ok(tipOf(formatBrief(c, Date.now(), 0)!)!.includes("tip A"));
  assert.ok(tipOf(formatBrief(c, Date.now(), 1)!)!.includes("tip B"));
  assert.ok(tipOf(formatBrief(c, Date.now(), 2)!)!.includes("tip C"));
  assert.ok(tipOf(formatBrief(c, Date.now(), 3)!)!.includes("tip A"), "wraps around");
});

test("lastSnippet strips the User: prefix and truncates long prompts", async () => {
  const { lastSnippet } = await import("../src/brief.js");
  assert.equal(lastSnippet("User: why is the sky blue?\n\nAssistant: …"), "why is the sky blue?");
  const long = "User: " + "x".repeat(200);
  assert.equal(lastSnippet(long).length, 90);
  assert.ok(lastSnippet(long).endsWith("…"));
});

test("formatBrief: adds a by-repo line when today spans more than one repo", () => {
  const oneRepo = [row({ id: "a:0", session_id: "a", repo: "aydhi" })];
  assert.ok(!formatBrief(cache(oneRepo, oneRepo))!.includes("by repo:"), "single repo → no split line");

  const twoRepos = [
    row({ id: "a:0", session_id: "a", repo: "aydhi", work_ms: 120_000 }),
    row({ id: "b:0", session_id: "b", repo: "Oh", work_ms: 60_000 }),
  ];
  const msg = formatBrief(cache(twoRepos, twoRepos))!;
  const line = msg.split("\n").find((l) => l.includes("by repo:"));
  assert.ok(line, "two repos → split line present");
  // busiest repo first
  assert.ok(line!.indexOf("aydhi") < line!.indexOf("Oh"), line);
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

function day(over: Partial<DailyStat>): DailyStat {
  return {
    date: "2026-06-10",
    promptMs: 0,
    awayMs: 0,
    workMs: 0,
    exchanges: 1,
    sessions: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    ...over,
  };
}

test("formatTokenChart: one stacked bar per day, split by agent, busiest day fills the bar", () => {
  const days = [
    day({ date: "2026-06-09", inputTokens: 1_000_000, byTool: { claude: 600_000, codex: 400_000 } }),
    day({ date: "2026-06-10", inputTokens: 200_000, byTool: { claude: 100_000, copilot: 100_000 } }),
  ];
  const chart = formatTokenChart(days);
  const lines = chart.split("\n");
  // Legend only names agents that actually spent tokens this window.
  assert.ok(lines[0]!.startsWith("Tokens by agent"), lines[0]);
  assert.ok(lines[0]!.includes("█ claude") && lines[0]!.includes("▓ codex") && lines[0]!.includes("▒ copilot"));

  const big = lines.find((l) => l.startsWith("2026-06-09"))!;
  const small = lines.find((l) => l.startsWith("2026-06-10"))!;
  const barLen = (l: string) => (l.match(/[█▓▒░]/g) ?? []).length;
  assert.equal(barLen(big), 22, "busiest day fills the full width");
  assert.ok(barLen(big) > barLen(small), "lighter day gets a shorter bar");
  assert.ok(big.includes("█") && big.includes("▓"), "claude + codex segments present");
  assert.ok(small.includes("█") && small.includes("▒"), "claude + copilot segments present");
  assert.ok(big.trimEnd().endsWith("1.0M"), big);
});

test("formatTokenChart: days without a recorded split fall back to an untracked fill", () => {
  const days = [
    day({ date: "2026-06-08", inputTokens: 500_000 }), // pre-byTool day
    day({ date: "2026-06-09", inputTokens: 500_000, byTool: { claude: 500_000 } }),
  ];
  const chart = formatTokenChart(days);
  assert.ok(chart.includes("░"), "untracked glyph used for the split-less day");
  assert.ok(chart.includes("recorded before the per-agent split"), "footnote explains the faint fill");
});

test("formatTokenChart: nothing to chart when no day has tokens", () => {
  assert.equal(formatTokenChart([day({ inputTokens: 0 })]), "");
});
