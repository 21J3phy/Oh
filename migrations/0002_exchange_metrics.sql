-- Oh v0.1 — capture-time Metrics for the Insights view (ADR 0007).
-- Mirror of the exchange_metrics block in src/schema.ts (canonical). Run once
-- in the Supabase SQL editor for stores created before v0.1; new stores get it
-- from `oh migrate` / ~/.oh/schema.sql. Idempotent.

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
