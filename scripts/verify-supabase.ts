// Live data-plane verification against a real Supabase project, using the
// actual db.ts / ask.ts code with deterministic fake 1536-dim vectors (no
// OpenAI needed). Proves: upsert (stringified-vector PostgREST path),
// match_chunks RPC (array param), similarity ordering, who/repo/since filters,
// the recency re-rank (latest-authoritative), and chunkCount — then cleans up.
//
// Run:  SUPABASE_URL=... SUPABASE_KEY=... npx tsx scripts/verify-supabase.ts

import { createDb } from "../src/db.js";
import { ask, formatAskResult } from "../src/ask.js";
import type { Config, Exchange } from "../src/types.js";
import type { Embedder } from "../src/embed.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_KEY env vars.");
  process.exit(1);
}

const cfg: Config = {
  author: "verify",
  supabaseUrl: url,
  supabaseKey: key,
  openaiKey: "unused",
  embeddingModel: "text-embedding-3-small",
  includeThinking: true,
  recencyHalfLifeDays: 30,
  recencyWeight: 0.25,
};

const DIM = 1536;
// Unit vector with cosine `c` to e0; orthogonal remainder on `axis`.
function vecForCos(c: number, axis = 1): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[0] = c;
  v[axis] = Math.sqrt(Math.max(0, 1 - c * c));
  return v;
}

const SESSION = "verify-oh";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const exchanges: Exchange[] = [
  {
    sessionId: SESSION, tool: "claude", author: "verify", repo: "oh-demo", cwd: "/x/oh-demo",
    index: 0, ts: daysAgo(70),
    reasoningText: "User: which job queue?\n\nAssistant: We'll use SQS for the background job queue.",
    toolSummaries: [],
  },
  {
    sessionId: SESSION, tool: "claude", author: "verify", repo: "oh-demo", cwd: "/x/oh-demo",
    index: 1, ts: daysAgo(0),
    reasoningText: "User: revisit the queue?\n\nAssistant: Switched the job queue from SQS to Redis Streams — SQS latency was too high.",
    toolSummaries: [],
  },
  {
    sessionId: SESSION, tool: "claude", author: "verify", repo: "oh-demo", cwd: "/x/oh-demo",
    index: 2, ts: daysAgo(0),
    reasoningText: "User: ci?\n\nAssistant: Bumped the CI Node version to 20.",
    toolSummaries: [],
  },
];

// idx0 (SQS, old) is the MOST similar to the query; idx1 (Redis, new) slightly
// less similar but newer; idx2 (CI) unrelated. The recency boost must flip
// idx1 above idx0 — that's the latest-authoritative behaviour.
const embeddings = [vecForCos(0.82), vecForCos(0.78), vecForCos(0.15, 2)];
const queryVec = vecForCos(1.0); // pure e0 = the "job queue" concept axis

const fakeEmbedder: Embedder = {
  async embed(texts) { return texts.map(() => queryVec); },
  async embedOne() { return queryVec; },
};

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const db = createDb(cfg);

  console.log("→ upserting session + 3 chunks (stringified-vector path)…");
  await db.upsertSession({
    sessionId: SESSION, tool: "claude", author: "verify", repo: "oh-demo",
    cwd: "/x/oh-demo", startedAt: daysAgo(70), lastSeenAt: daysAgo(0),
  });
  await db.upsertChunks(exchanges, embeddings);
  check("upsert succeeded (vector insert via PostgREST works)", true);

  console.log("\n→ raw match_chunks (pure similarity, before recency)…");
  const raw = await db.matchChunks(queryVec, 30, {});
  for (const r of raw) console.log(`   ${r.id}  sim=${r.similarity.toFixed(3)}  ts=${r.ts.slice(0, 10)}`);
  check("RPC returned all 3 candidates", raw.length === 3, `${raw.length} rows`);
  check("pure-similarity leader is the OLD SQS chunk (idx0)", raw[0]?.id === `${SESSION}:0`, raw[0]?.id);

  console.log("\n→ ask() with recency re-rank…");
  const result = await ask(cfg, db, fakeEmbedder, { question: "why did we choose our job queue?" });
  console.log(formatAskResult(result));
  const top = result.hits[0];
  check("latest-authoritative: recency flips the NEW Redis chunk to #1", top?.text.includes("Redis") === true, top?.text.slice(0, 60));

  console.log("\n→ filters…");
  check("repo=oh-demo returns 3", (await db.matchChunks(queryVec, 30, { repo: "oh-demo" })).length === 3);
  check("repo=nope returns 0", (await db.matchChunks(queryVec, 30, { repo: "nope" })).length === 0);
  check("author ilike %verify% returns 3", (await db.matchChunks(queryVec, 30, { author: "%verify%" })).length === 3);
  const recent = await db.matchChunks(queryVec, 30, { since: daysAgo(1) });
  check("since=1d ago excludes the 70-day-old chunk", recent.length === 2, `${recent.length} rows`);

  check("chunkCount >= 3", (await db.chunkCount()) >= 3);

  console.log("\n→ cleaning up verification rows…");
  await db.raw.from("chunks").delete().eq("session_id", SESSION);
  await db.raw.from("sessions").delete().eq("id", SESSION);
  check("cleanup done (store left empty)", (await db.chunkCount()) === 0);
}

main().catch((err) => {
  console.error("\n✗ verification failed:", (err as Error).message);
  if (/relation .* does not exist|Could not find the|schema cache/i.test((err as Error).message)) {
    console.error("  → Looks like the schema isn't applied yet. Paste migrations/0001_init.sql into the SQL editor and Run.");
  }
  process.exitCode = 1;
});
