// True end-to-end: REAL OpenAI embeddings → Supabase → semantic ask. Embeds
// three synthetic exchanges (job-queue decision, reversed; plus an unrelated CI
// note), then asks a real question and checks that semantic retrieval ranks the
// queue exchanges above the unrelated one, and shows the recency re-rank. Then
// cleans up. Synthetic content = no real history leaves the machine.
//
// Run: SUPABASE_URL=… SUPABASE_KEY=… OPENAI_API_KEY=… npx tsx scripts/verify-e2e.ts

import { createDb } from "../src/db.js";
import { createEmbedder } from "../src/embed.js";
import { ask, formatAskResult } from "../src/ask.js";
import type { Config, Exchange } from "../src/types.js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
if (!url || !key || !openaiKey) {
  console.error("Set SUPABASE_URL, SUPABASE_KEY, OPENAI_API_KEY.");
  process.exit(1);
}

const cfg: Config = {
  author: "verify",
  supabaseUrl: url,
  supabaseKey: key,
  openaiKey,
  embeddingModel: "text-embedding-3-small",
  includeThinking: true,
  recencyHalfLifeDays: 30,
  recencyWeight: 0.25,
};

const SESSION = "verify-e2e";
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const base = { sessionId: SESSION, tool: "claude" as const, author: "verify", repo: "oh-demo", cwd: "/x/oh-demo", toolSummaries: [] };

const exchanges: Exchange[] = [
  { ...base, index: 0, ts: daysAgo(70), reasoningText: "User: what should we use for the background job queue?\n\nAssistant: We'll use AWS SQS for the background job queue — it's simple and managed." },
  { ...base, index: 1, ts: daysAgo(0), reasoningText: "User: should we revisit the job queue choice?\n\nAssistant: Switched the background job queue from SQS to Redis Streams — SQS tail latency was too high for our workload." },
  { ...base, index: 2, ts: daysAgo(0), reasoningText: "User: anything to do in CI?\n\nAssistant: Bumped the CI runner's Node version to 20 and re-pinned the lockfile." },
];

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  const db = createDb(cfg);
  const embedder = createEmbedder(cfg);

  console.log("→ embedding 3 exchanges with OpenAI + upserting…");
  const vecs = await embedder.embed(exchanges.map((e) => e.reasoningText));
  check("OpenAI returned 1536-dim embeddings", vecs.every((v) => v.length === 1536), `dim=${vecs[0]?.length}`);
  await db.upsertSession({ sessionId: SESSION, tool: "claude", author: "verify", repo: "oh-demo", cwd: "/x/oh-demo", startedAt: daysAgo(70), lastSeenAt: daysAgo(0) });
  await db.upsertChunks(exchanges, vecs);

  const question = "why did we choose our background job queue?";
  console.log(`\n→ ask("${question}") — real semantic retrieval + recency re-rank:\n`);
  const result = await ask(cfg, db, embedder, { question });
  console.log(formatAskResult(result));

  const order = result.hits.map((h) => (h.text.includes("CI runner") ? "CI" : h.text.includes("Redis") ? "Redis" : "SQS"));
  const ciRank = order.indexOf("CI");
  check("both queue exchanges rank above the unrelated CI note (semantic relevance works)", ciRank === order.length - 1, `order: ${order.join(" > ")}`);
  check("top hit is queue-related, not CI", order[0] !== "CI", `#1 = ${order[0]}`);
  console.log(
    order[0] === "Redis"
      ? "ℹ latest-authoritative: recency surfaced the NEWER 'switched to Redis' decision at #1."
      : "ℹ note: SQS ranked #1 here — real-embedding similarity gap outweighed the recency boost; recencyWeight is tunable in config.",
  );

  console.log("\n→ cleaning up…");
  await db.raw.from("chunks").delete().eq("session_id", SESSION);
  await db.raw.from("sessions").delete().eq("id", SESSION);
  check("cleanup done", (await db.chunkCount()) === 0);
}

main().catch((err) => {
  console.error("\n✗ e2e failed:", (err as Error).message);
  process.exitCode = 1;
});
