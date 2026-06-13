// Row shapes mirrored from ../../src/db.ts so the web app reads the hosted
// tables with the same column contract as the CLI. Keep in sync with db.ts.

export type Tool = "claude" | "codex";

export interface MetricsRow {
  id: string;
  session_id: string;
  author: string;
  tool: Tool;
  repo: string | null;
  exchange_index: number;
  ts: string;
  ended_at: string;
  think_ms: number | null;
  work_ms: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  tool_calls: number;
  file_reads: number;
  file_edits: number;
  errors: number;
  interrupted: boolean;
  is_correction: boolean;
  model: string | null;
}

export interface MatchRow {
  id: string;
  session_id: string;
  author: string;
  tool: Tool;
  repo: string | null;
  cwd: string | null;
  exchange_index: number;
  text: string;
  ts: string;
  similarity: number;
}

// my_teams() RPC return row.
export interface TeamRow {
  team_id: string;
  team_name: string;
  author_name: string;
  role: "owner" | "member";
  invite_code: string | null;
}

// members table row (RLS: SELECT for team members).
export interface MemberRow {
  team_id: string;
  user_id: string;
  author_name: string;
  role: "owner" | "member";
  joined_at: string;
}
