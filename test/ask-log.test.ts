import { test } from "node:test";
import assert from "node:assert/strict";
import { ask } from "../src/ask.js";
import type { AskLogEntry, Db, MatchRow } from "../src/db.js";
import type { Config } from "../src/types.js";

const cfg: Config = {
  author: "alice",
  supabaseUrl: "http://x",
  supabaseKey: "k",
  openaiKey: "k",
  embeddingModel: "text-embedding-3-small",
  includeThinking: true,
  recencyHalfLifeDays: 30,
  recencyWeight: 0.25,
};

const row: MatchRow = {
  id: "s1:0",
  session_id: "s1",
  author: "bob",
  tool: "claude",
  repo: "proj",
  cwd: "/x",
  exchange_index: 0,
  text: "User: why X?\n\nAssistant: because Y.",
  ts: new Date().toISOString(),
  similarity: 0.82,
};

function stubDb(matches: MatchRow[], logged: AskLogEntry[], failLog = false): Db {
  return {
    upsertSession: async () => {},
    upsertChunks: async () => {},
    upsertMetrics: async () => {},
    fetchMetrics: async () => [],
    matchChunks: async () => matches,
    chunkCount: async () => 0,
    askStats: async () => ({ total: 0, answered: 0 }),
    latestChunk: async () => null,
    logAsk: async (e) => {
      if (failLog) throw new Error("no asks table");
      logged.push(e);
    },
  };
}

const embedder = { embed: async (ts: string[]) => ts.map(() => [0]), embedOne: async () => [0] } as never;

test("every ask is logged with hits, top similarity, and a scrubbed question", async () => {
  const logged: AskLogEntry[] = [];
  const r = await ask(cfg, stubDb([row], logged), embedder, {
    question: "why X? my key is sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    repo: "proj",
  });
  assert.equal(r.hits.length, 1);
  // logAsk is fire-and-forget — let the microtask settle
  await new Promise((res) => setImmediate(res));
  assert.equal(logged.length, 1);
  assert.equal(logged[0]!.author, "alice", "logs the ASKER, not the answer's author");
  assert.equal(logged[0]!.hits, 1);
  assert.equal(logged[0]!.topSimilarity, 0.82);
  assert.equal(logged[0]!.repoFilter, "proj");
  assert.ok(logged[0]!.question.includes("«secret»"), "question is scrubbed before it lands");
  assert.ok(!logged[0]!.question.includes("sk-proj-"), "no raw key in the log");
});

test("an unanswered ask logs hits=0; a failing log never breaks the answer", async () => {
  const logged: AskLogEntry[] = [];
  const r0 = await ask(cfg, stubDb([], logged), embedder, { question: "anything?" });
  await new Promise((res) => setImmediate(res));
  assert.equal(r0.hits.length, 0);
  assert.equal(logged[0]!.hits, 0);
  assert.equal(logged[0]!.topSimilarity, null);

  const r1 = await ask(cfg, stubDb([row], [], true), embedder, { question: "why X?" });
  await new Promise((res) => setImmediate(res));
  assert.equal(r1.hits.length, 1, "answer survives a logAsk failure");
});

const failingEmbedder = {
  embed: async () => {
    throw new Error("model runtime not installed");
  },
  embedOne: async () => {
    throw new Error("model runtime not installed");
  },
} as never;

test("ask falls back to keywordMatch when the embedding model fails (local mode)", async () => {
  const logged: AskLogEntry[] = [];
  const db = stubDb([], logged);
  let kwQuery: string | null = null;
  db.keywordMatch = async (q) => {
    kwQuery = q;
    return [row];
  };
  const r = await ask(cfg, db, failingEmbedder, { question: "why X?" });
  assert.equal(kwQuery, "why X?", "the question is keyword-searched");
  assert.equal(r.hits.length, 1, "keyword fallback still answers");
});

test("ask surfaces the embed error when no keyword fallback exists (hosted/self-host)", async () => {
  const db = stubDb([], []); // no keywordMatch
  await assert.rejects(
    ask(cfg, db, failingEmbedder, { question: "why X?" }),
    /model runtime not installed/,
  );
});
