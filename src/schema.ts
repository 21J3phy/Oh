// Canonical Oh v0 schema. This string is the source of truth shipped in the
// binary; migrations/0001_init.sql mirrors it for humans and direct psql use.
// Dimension 1536 matches OpenAI text-embedding-3-small and is baked in here.

export const SCHEMA_SQL = `-- Oh v0 — shared Team Brain (Supabase / Postgres + pgvector)

create extension if not exists vector;

create table if not exists sessions (
  id           text primary key,
  tool         text not null,
  author       text not null,
  repo         text,
  cwd          text,
  started_at   timestamptz,
  last_seen_at timestamptz
);

create table if not exists chunks (
  id             text primary key,        -- '<session_id>:<exchange_index>'
  session_id     text not null references sessions(id) on delete cascade,
  author         text not null,
  tool           text not null,
  repo           text,
  cwd            text,
  exchange_index int  not null,
  text           text not null,
  ts             timestamptz not null,
  embedding      vector(1536) not null
);

create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
create index if not exists chunks_repo_ts_idx   on chunks (repo, ts desc);
create index if not exists chunks_author_idx    on chunks (author);
create index if not exists chunks_session_idx   on chunks (session_id);

-- Capture-time Metrics, one row per exchange (ADR 0007). Mechanical facts only
-- (tokens, durations, errors) parsed from the same files Capture reads; no
-- embedding. Read by the Insights view ('oh insights') and the rabbit-hole Nudge.
create table if not exists exchange_metrics (
  id                 text primary key,    -- '<session_id>:<exchange_index>'
  session_id         text not null references sessions(id) on delete cascade,
  author             text not null,
  tool               text not null,
  repo               text,
  exchange_index     int  not null,
  ts                 timestamptz not null,
  ended_at           timestamptz not null,
  think_ms           bigint,              -- gap from previous exchange's end to this prompt
  work_ms            bigint not null default 0,
  input_tokens       bigint not null default 0,
  output_tokens      bigint not null default 0,
  cache_read_tokens  bigint not null default 0,
  cache_write_tokens bigint not null default 0,
  tool_calls         int not null default 0,
  file_reads         int not null default 0,
  file_edits         int not null default 0,
  errors             int not null default 0,
  interrupted        boolean not null default false,
  is_correction      boolean not null default false,
  model              text
);

create index if not exists exchange_metrics_author_ts_idx  on exchange_metrics (author, ts desc);
create index if not exists exchange_metrics_repo_ts_idx    on exchange_metrics (repo, ts desc);
create index if not exists exchange_metrics_session_idx    on exchange_metrics (session_id);

-- Every ask, logged (ADR 0008). An answered ask is a deflected interruption —
-- the retention metric AND the future first line of the sales pitch are the
-- same number. Question text is scrubbed before it lands.
create table if not exists asks (
  id             text primary key,
  author         text not null,       -- who asked
  question       text not null,
  repo_filter    text,
  who_filter     text,
  hits           int not null default 0,
  top_similarity double precision,
  ts             timestamptz not null
);

create index if not exists asks_ts_idx     on asks (ts desc);
create index if not exists asks_author_idx on asks (author);

-- Top-N similarity search with optional who/repo/since filters. The recency
-- re-rank (similarity + lambda*recency) happens client-side over these rows.
create or replace function match_chunks(
  query_embedding vector(1536),
  match_count     int default 30,
  p_repo          text default null,
  p_author        text default null,
  p_since         timestamptz default null
) returns table (
  id             text,
  session_id     text,
  author         text,
  tool           text,
  repo           text,
  cwd            text,
  exchange_index int,
  text           text,
  ts             timestamptz,
  similarity     double precision
) language sql stable as $$
  select c.id, c.session_id, c.author, c.tool, c.repo, c.cwd,
         c.exchange_index, c.text, c.ts,
         1 - (c.embedding <=> query_embedding) as similarity
  from chunks c
  where (p_repo   is null or c.repo = p_repo)
    and (p_author is null or c.author ilike p_author)
    and (p_since  is null or c.ts >= p_since)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
`;
