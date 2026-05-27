// OpenAI embeddings wrapper. text-embedding-3-small → 1536-dim vectors.
// Inputs are truncated (the "why" is front-loaded in an exchange) and batched.

import OpenAI from "openai";
import type { Config } from "./types.js";

// ~4 chars/token; stay well under the model's 8191-token input limit and keep
// chunks focused on the high-signal head of an exchange.
const EMBED_MAX_CHARS = 16_000;
const BATCH = 96;

export function truncateForEmbedding(text: string): string {
  const t = text.length > EMBED_MAX_CHARS ? text.slice(0, EMBED_MAX_CHARS) : text;
  // OpenAI rejects empty input; never send a zero-length string.
  return t.trim() ? t : " ";
}

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  embedOne(text: string): Promise<number[]>;
}

export function createEmbedder(cfg: Config): Embedder {
  const client = new OpenAI({ apiKey: cfg.openaiKey });
  const model = cfg.embeddingModel;

  async function embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const input = texts.slice(i, i + BATCH).map(truncateForEmbedding);
      const res = await client.embeddings.create({ model, input });
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) out.push(d.embedding as number[]);
    }
    return out;
  }

  return {
    embed,
    async embedOne(text: string): Promise<number[]> {
      const [v] = await embed([text]);
      if (!v) throw new Error("embedding failed: empty response");
      return v;
    },
  };
}
