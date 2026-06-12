// Shared types for Oh — the v0 "ask" engine.

export type Tool = "claude" | "codex";

/** ~/.oh/config.json — read by every local component. */
export interface Config {
  /** Display name attributed to this person's Sessions in the Team Brain. */
  author: string;
  /** Shared Supabase project URL. */
  supabaseUrl: string;
  /**
   * Supabase key. For the v0 dogfood this is the service-role key: clients
   * read AND write the shared store directly, no backend, no RLS. The tradeoff
   * (shared creds among a few trusted people) is accepted in ADR 0006 / the plan.
   */
  supabaseKey: string;
  /** OpenAI API key — used for embeddings at capture time and query time. */
  openaiKey: string;
  /** Embedding model. Must stay fixed for a store (dimension is baked into the schema). */
  embeddingModel: string;
  /** Include assistant `thinking` blocks (Claude) / `reasoning` summaries (Codex) in the embedded text. */
  includeThinking: boolean;
  /** Recency half-life in days for the re-rank decay. */
  recencyHalfLifeDays: number;
  /** Weight (λ) of the recency term relative to cosine similarity in the final score. */
  recencyWeight: number;
  /**
   * Optional allowlist of git projects to capture. Each entry is matched as a
   * (case-insensitive) substring of a session's normalized git remote, e.g.
   * "chadvschud" or "github.com/21j3phy/chadvschud". When set and non-empty,
   * only sessions whose cwd resolves to a matching remote are captured (applies
   * to both backfill and the ongoing hook). Omit/empty = capture everything.
   */
  repos?: string[];
}

/** Token usage attributable to a single event (already deduped/diffed by the parser). */
export interface UsageDelta {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** A single meaningful event parsed out of a tool's raw JSONL. */
export interface ParsedEvent {
  kind: "user" | "assistant" | "reasoning" | "tool_call" | "tool_result" | "meta";
  /** ISO-8601 timestamp of the event. */
  ts: string;
  /** Text content for user / assistant / reasoning events. */
  text?: string;
  /** Tool name for tool_call events. */
  toolName?: string;
  /** One-line "what they did" summary for tool_call events. */
  toolSummary?: string;
  /** Event-level cwd when the source carries one (Codex turn_context, Claude per-event). */
  cwd?: string;
  /** Token usage carried by this event (Claude: per assistant message; Codex: token_count delta). */
  usage?: UsageDelta;
  /** Model id, when the source carries one (Claude assistant messages). */
  model?: string;
  /** tool_result events: the tool reported an error / non-zero exit. */
  isError?: boolean;
  /** user events that are "[Request interrupted …]" markers, not real prompts. */
  interrupted?: boolean;
}

/**
 * Mechanical facts about one Exchange, computed at capture time from data the
 * parsers already read (ADR 0007). Stored without an embedding.
 */
export interface ExchangeMetrics {
  /** ISO-8601 timestamp of the last event in the exchange. */
  endedAt: string;
  /** ms from the previous exchange's last event to this prompt (null for the first). */
  thinkMs: number | null;
  /** ms from the prompt to the last agent event in the exchange. */
  workMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  fileReads: number;
  fileEdits: number;
  /** tool_result events that reported an error / non-zero exit. */
  errors: number;
  /** The exchange opened with an interrupt marker (the user cut the agent off). */
  interrupted: boolean;
  /** The prompt reads as a correction of the previous turn ("no", "still failing", …). */
  isCorrection: boolean;
  /** Model that did the work, when known. */
  model: string | null;
}

/**
 * One Exchange = one human prompt plus the assistant work that answered it
 * (replies, reasoning, tool actions) up to the next human prompt. This is the
 * unit we embed and store as a chunk.
 */
export interface Exchange {
  sessionId: string;
  tool: Tool;
  author: string;
  repo: string;
  cwd: string;
  /** 0-based position of this exchange within its Session. */
  index: number;
  /** ISO-8601 timestamp of the human prompt that opened the exchange. */
  ts: string;
  /** The embeddable reasoning text (prompt + explanation + tool one-liners). */
  reasoningText: string;
  /** The one-line tool action summaries, kept separately for display. */
  toolSummaries: string[];
  /** Capture-time mechanical facts (tokens, durations, errors). Never embedded. */
  metrics: ExchangeMetrics;
}

/** The result of parsing one raw session file into common events. */
export interface ParseResult {
  tool: Tool;
  /** Session id from the file's own metadata (UUID for Claude, ULID for Codex). */
  sessionId: string | null;
  /** Best-known working directory for the session. */
  cwd: string | null;
  events: ParsedEvent[];
}

/** Session-level metadata row. */
export interface SessionMeta {
  sessionId: string;
  tool: Tool;
  author: string;
  cwd: string;
  repo: string;
  startedAt: string;
  lastSeenAt: string;
}

/** A ranked result returned by `ask`. */
export interface AskHit {
  text: string;
  who: string;
  tool: Tool;
  repo: string | null;
  sessionId: string;
  ts: string;
  /** Cosine similarity in [0,1]. */
  similarity: number;
  /** Final score after the recency re-rank. */
  score: number;
}
