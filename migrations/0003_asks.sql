-- Oh v0.2 — ask-deflection instrumentation (ADR 0008).
-- Mirror of the asks block in src/schema.ts (canonical). Run once in the
-- Supabase SQL editor for stores created before v0.2. Idempotent.

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
