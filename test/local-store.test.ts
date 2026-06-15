import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalDb } from "../src/local/store.js";
import type { Exchange } from "../src/types.js";

// A file-backed Team Brain with no cloud, no keys, no network — the local mode.
// These tests pin the behaviour the rest of Oh relies on: deterministic ids
// (upsert, not duplicate), brute-force cosine ranking, and the same filters
// Supabase enforces.

function ex(sessionId: string, index: number, text: string, over: Partial<Exchange> = {}): Exchange {
  return {
    sessionId,
    tool: "claude",
    author: over.author ?? "alice",
    repo: over.repo ?? "github.com/acme/widget",
    cwd: "/tmp/widget",
    index,
    ts: over.ts ?? `2026-06-${String(10 + index).padStart(2, "0")}T00:00:00.000Z`,
    reasoningText: text,
    toolSummaries: [],
    metrics: {
      endedAt: over.ts ?? `2026-06-${String(10 + index).padStart(2, "0")}T00:05:00.000Z`,
      thinkMs: null,
      workMs: 1000,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      toolCalls: 1,
      fileReads: 0,
      fileEdits: 0,
      errors: 0,
      interrupted: false,
      isCorrection: false,
      model: "claude-opus-4-8",
    },
    ...over,
  };
}

function withDir(fn: (dir: string) => Promise<void> | void) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "oh-local-"));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  "chunks upsert by deterministic id — re-capture overwrites, never duplicates",
  withDir(async (dir) => {
    const db = createLocalDb(dir);
    await db.upsertChunks([ex("s1", 0, "first")], [[1, 0, 0]]);
    await db.upsertChunks([ex("s1", 0, "first revised")], [[1, 0, 0]]);
    await db.upsertChunks([ex("s1", 1, "second")], [[0, 1, 0]]);
    assert.equal(await db.chunkCount(), 2, "two distinct exchanges, the first updated in place");

    // A fresh handle reads the persisted file — proves it round-tripped to disk.
    const reopened = createLocalDb(dir);
    assert.equal(await reopened.chunkCount(), 2);
  }),
);

test(
  "matchChunks ranks by cosine similarity",
  withDir(async (dir) => {
    const db = createLocalDb(dir);
    await db.upsertChunks(
      [ex("s1", 0, "about auth"), ex("s1", 1, "about billing")],
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
    );
    const hits = await db.matchChunks([0.9, 0.1, 0], 10, {});
    assert.equal(hits.length, 2);
    assert.equal(hits[0]!.text, "about auth", "closest vector ranks first");
    assert.ok(hits[0]!.similarity > hits[1]!.similarity, "similarity is ordered");
  }),
);

test(
  "matchChunks honours repo / author / since filters (mirrors Supabase)",
  withDir(async (dir) => {
    const db = createLocalDb(dir);
    await db.upsertChunks(
      [
        ex("s1", 0, "alice on widget", { author: "alice", repo: "r1", ts: "2026-06-01T00:00:00.000Z" }),
        ex("s2", 0, "bob on gadget", { author: "bob", repo: "r2", ts: "2026-06-20T00:00:00.000Z" }),
      ],
      [
        [1, 0, 0],
        [1, 0, 0],
      ],
    );
    assert.equal((await db.matchChunks([1, 0, 0], 10, { repo: "r1" })).length, 1);
    assert.equal((await db.matchChunks([1, 0, 0], 10, { author: "%bob%" }))[0]!.text, "bob on gadget");
    assert.equal((await db.matchChunks([1, 0, 0], 10, { since: "2026-06-10T00:00:00.000Z" })).length, 1);
  }),
);

test(
  "metrics + asks round-trip; askStats counts answered",
  withDir(async (dir) => {
    const db = createLocalDb(dir);
    await db.upsertMetrics([ex("s1", 0, "x"), ex("s1", 1, "y")]);
    assert.equal((await db.fetchMetrics({})).length, 2);
    await db.upsertMetrics([ex("s1", 0, "x")]); // idempotent
    assert.equal((await db.fetchMetrics({})).length, 2);

    await db.logAsk({ author: "alice", question: "why x?", repoFilter: null, whoFilter: null, hits: 3, topSimilarity: 0.8 });
    await db.logAsk({ author: "alice", question: "why y?", repoFilter: null, whoFilter: null, hits: 0, topSimilarity: null });
    const stats = await db.askStats("2026-01-01T00:00:00.000Z");
    assert.deepEqual(stats, { total: 2, answered: 1 });
  }),
);
