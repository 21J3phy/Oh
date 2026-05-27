import { test } from "node:test";
import assert from "node:assert/strict";
import { rerank, parseSince, recencyScore } from "../src/ask.js";
import type { MatchRow } from "../src/db.js";
import type { Config } from "../src/types.js";

const cfg: Config = {
  author: "tester",
  supabaseUrl: "https://x.supabase.co",
  supabaseKey: "k",
  openaiKey: "k",
  embeddingModel: "text-embedding-3-small",
  includeThinking: true,
  recencyHalfLifeDays: 30,
  recencyWeight: 0.25,
};

const now = Date.parse("2026-05-26T00:00:00.000Z");

function row(id: string, similarity: number, ageDays: number): MatchRow {
  return {
    id,
    session_id: id,
    author: "tester",
    tool: "claude",
    repo: "repo",
    cwd: "/repo",
    exchange_index: 0,
    text: `chunk ${id}`,
    ts: new Date(now - ageDays * 86_400_000).toISOString(),
    similarity,
  };
}

test("recency boost makes a newer, slightly-less-similar chunk win (latest authoritative)", () => {
  const stale = row("stale", 0.8, 60); // higher similarity, 60 days old
  const fresh = row("fresh", 0.74, 0); // lower similarity, brand new
  const ranked = rerank([stale, fresh], cfg, now);
  assert.equal(ranked[0]!.sessionId, "fresh", "the current decision should rank first");
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test("with zero recency weight, pure similarity decides", () => {
  const stale = row("stale", 0.8, 60);
  const fresh = row("fresh", 0.74, 0);
  const ranked = rerank([stale, fresh], { ...cfg, recencyWeight: 0 }, now);
  assert.equal(ranked[0]!.sessionId, "stale");
});

test("recencyScore decays by half each half-life", () => {
  assert.ok(Math.abs(recencyScore(now, now, 30) - 1) < 1e-9);
  assert.ok(Math.abs(recencyScore(now - 30 * 86_400_000, now, 30) - 0.5) < 1e-9);
  assert.ok(Math.abs(recencyScore(now - 60 * 86_400_000, now, 30) - 0.25) < 1e-9);
});

test("parseSince handles windows, ISO dates, and junk", () => {
  assert.equal(parseSince(undefined), null);
  assert.equal(parseSince("not a date"), null);
  assert.ok(parseSince("2026-01-01")!.startsWith("2026-01-01"));
  const sevenDays = Date.parse(parseSince("7d")!);
  const expected = Date.now() - 7 * 86_400_000;
  assert.ok(Math.abs(sevenDays - expected) < 5000, "7d is ~7 days ago");
});
