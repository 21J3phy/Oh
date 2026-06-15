// Embeddings. Self-host: OpenAI direct with your key. Hosted: Oh's embed proxy
// (it holds the key; your JWT authenticates — ADR 0010). Either way,
// text-embedding-3-small → 1536-dim vectors, truncated and batched.

import OpenAI from "openai";
import { EMBED_ENDPOINT, hostedClient } from "./hosted.js";
import { localEmbed } from "./local/embed.js";
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
  const embed =
    cfg.mode === "local"
      ? localEmbed(cfg)
      : cfg.mode === "hosted"
        ? hostedEmbed(cfg)
        : selfhostEmbed(cfg);

  return {
    embed,
    async embedOne(text: string): Promise<number[]> {
      const [v] = await embed([text]);
      if (!v) throw new Error("embedding failed: empty response");
      return v;
    },
  };
}

function selfhostEmbed(cfg: Config): (texts: string[]) => Promise<number[][]> {
  const client = new OpenAI({ apiKey: cfg.openaiKey! });
  const model = cfg.embeddingModel;
  return async (texts) => {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const input = texts.slice(i, i + BATCH).map(truncateForEmbedding);
      const res = await client.embeddings.create({ model, input });
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) out.push(d.embedding as number[]);
    }
    return out;
  };
}

function hostedEmbed(cfg: Config): (texts: string[]) => Promise<number[][]> {
  return async (texts) => {
    // hostedClient refreshes the token if needed and persists it.
    await hostedClient(cfg);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map(truncateForEmbedding);
      const res = await fetch(EMBED_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${cfg.hosted!.accessToken}`,
        },
        body: JSON.stringify({ texts: batch }),
      });
      if (!res.ok) {
        const detail = await res.text();
        throw new Error(`embed proxy ${res.status}: ${detail.slice(0, 200)}`);
      }
      const { embeddings } = (await res.json()) as { embeddings: number[][] };
      out.push(...embeddings);
    }
    return out;
  };
}
