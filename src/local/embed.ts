// Local-mode embeddings (ADR 0013): an embedding model that runs in THIS
// process — no OpenAI, no network per query. The model weights are fetched once
// (from the Hugging Face CDN) into ~/.oh/models and reused forever after; on an
// air-gapped machine, copy that directory across and it never touches the
// network at all. Default model: all-MiniLM-L6-v2 (384-dim, ~23MB quantized) —
// the standard small sentence-embedding model, good enough for code-session
// recall and tiny enough to ship.

import { MODELS_DIR } from "../config.js";
import type { Config } from "../types.js";

export const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";

// MiniLM tops out near 256 tokens (~1k chars); the tokenizer truncates, but we
// trim first to keep the embedded text on the high-signal head of an exchange.
const LOCAL_MAX_CHARS = 2_000;
const BATCH = 32;

// `@huggingface/transformers` (or its predecessor `@xenova/transformers`) is an
// optional dependency loaded lazily so non-local builds never pay for it. Typed
// loosely on purpose — we don't want a hard type dependency on an optional pkg.
let pipePromise: Promise<(texts: string[]) => Promise<number[][]>> | null = null;

async function loadRuntime(): Promise<any> {
  const candidates = ["@huggingface/transformers", "@xenova/transformers"];
  for (const name of candidates) {
    try {
      return await import(/* @vite-ignore */ name);
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "local embeddings need an in-process model runtime that isn't installed.\n" +
      "  Install it once:  npm i -g @huggingface/transformers\n" +
      "  (it downloads a ~23MB model into ~/.oh/models on first use, then runs fully offline).",
  );
}

function getPipe(model: string): Promise<(texts: string[]) => Promise<number[][]>> {
  if (pipePromise) return pipePromise;
  const p = (async () => {
    const tf = await loadRuntime();
    // Keep all weights under ~/.oh so the footprint is one predictable dir, and
    // allow the offline path (use the cache, don't re-fetch) once present.
    if (tf.env) {
      tf.env.cacheDir = MODELS_DIR;
      tf.env.allowLocalModels = true;
      if (process.env.OH_OFFLINE === "1") tf.env.allowRemoteModels = false;
    }
    // Quantized (int8) weights: ~23MB instead of ~98MB fp32, ~4× less memory,
    // and it silences the runtime's "dtype not specified" warning. Recall quality
    // for session-excerpt retrieval is indistinguishable from fp32 at this size.
    const extractor = await tf.pipeline("feature-extraction", model, { dtype: "q8" });
    return async (texts: string[]) => {
      const out = await extractor(texts, { pooling: "mean", normalize: true });
      return out.tolist() as number[][];
    };
  })();
  // Don't permanently cache a failed load: if the runtime is missing or the
  // first download fails, clear the promise so a later call (after the user
  // installs it / comes back online) retries instead of replaying the rejection.
  pipePromise = p;
  p.catch(() => {
    if (pipePromise === p) pipePromise = null;
  });
  return p;
}

function truncate(text: string): string {
  const t = text.length > LOCAL_MAX_CHARS ? text.slice(0, LOCAL_MAX_CHARS) : text;
  return t.trim() ? t : " ";
}

/** The mode === "local" embedder, shaped like the OpenAI one in embed.ts. */
export function localEmbed(cfg: Config): (texts: string[]) => Promise<number[][]> {
  const model = cfg.embeddingModel?.startsWith("text-embedding")
    ? DEFAULT_LOCAL_MODEL // ignore an OpenAI default that lingered in config
    : cfg.embeddingModel || DEFAULT_LOCAL_MODEL;
  return async (texts) => {
    const pipe = await getPipe(model);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH).map(truncate);
      out.push(...(await pipe(batch)));
    }
    return out;
  };
}
