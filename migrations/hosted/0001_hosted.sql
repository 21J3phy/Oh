-- Oh hosted (v0.3) — multi-tenant Team Brain (ADR 0010).
-- Applied to the Oh-owned Supabase project. Clients connect with the anon key
-- + a user JWT; every guarantee below is enforced by RLS, not application code.
-- Idempotent.

create extension if not exists vector;

-- ---- tenancy ---------------------------------------------------------------

create table if not exists teams (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists members (
  team_id     uuid not null references teams(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  author_name text not null,          -- display name on this team's rows
  role        text not null default 'member',  -- 'owner' | 'member'
  joined_at   timestamptz not null default now(),
  primary key (team_id, user_id)
);

create table if not exists invites (
  code       text primary key,
  team_id    uuid not null references teams(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

-- True iff the CALLER belongs to the team. security definer so RLS policies
-- can use it without recursing into members' own policy.
create or replace function is_member(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from members where team_id = t and user_id = auth.uid());
$$;

-- ---- data tables (v0 shape + team_id/author_id) -----------------------------

create table if not exists sessions (
  id           text primary key,
  team_id      uuid not null references teams(id) on delete cascade,
  author_id    uuid not null references auth.users(id),
  tool         text not null,
  author       text not null,
  repo         text,
  cwd          text,
  started_at   timestamptz,
  last_seen_at timestamptz
);

create table if not exists chunks (
  id             text primary key,        -- '<session_id>:<exchange_index>'
  team_id        uuid not null references teams(id) on delete cascade,
  author_id      uuid not null references auth.users(id),
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
create index if not exists chunks_team_ts_idx   on chunks (team_id, ts desc);
create index if not exists chunks_repo_ts_idx   on chunks (repo, ts desc);
create index if not exists chunks_session_idx   on chunks (session_id);

create table if not exists exchange_metrics (
  id                 text primary key,
  team_id            uuid not null references teams(id) on delete cascade,
  author_id          uuid not null references auth.users(id),
  session_id         text not null references sessions(id) on delete cascade,
  author             text not null,
  tool               text not null,
  repo               text,
  exchange_index     int  not null,
  ts                 timestamptz not null,
  ended_at           timestamptz not null,
  think_ms           bigint,
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

create index if not exists exchange_metrics_author_ts_idx on exchange_metrics (author_id, ts desc);
create index if not exists exchange_metrics_session_idx   on exchange_metrics (session_id);

create table if not exists asks (
  id             text primary key,
  team_id        uuid not null references teams(id) on delete cascade,
  author_id      uuid not null references auth.users(id),
  author         text not null,
  question       text not null,
  repo_filter    text,
  who_filter     text,
  hits           int not null default 0,
  top_similarity double precision,
  ts             timestamptz not null
);

create index if not exists asks_team_ts_idx on asks (team_id, ts desc);

-- ---- RLS --------------------------------------------------------------------

alter table teams            enable row level security;
alter table members          enable row level security;
alter table invites          enable row level security;
alter table sessions         enable row level security;
alter table chunks           enable row level security;
alter table exchange_metrics enable row level security;
alter table asks             enable row level security;

-- teams/members/invites: visible to members; writes go through the RPCs below.
drop policy if exists teams_select on teams;
create policy teams_select on teams for select using (is_member(id));

drop policy if exists members_select on members;
create policy members_select on members for select using (is_member(team_id));

drop policy if exists invites_select on invites;
create policy invites_select on invites for select using (is_member(team_id));

-- sessions/chunks: the shared memory — any team member, but you write as yourself.
drop policy if exists sessions_select on sessions;
create policy sessions_select on sessions for select using (is_member(team_id));
drop policy if exists sessions_write on sessions;
create policy sessions_write on sessions for all
  using (is_member(team_id) and author_id = auth.uid())
  with check (is_member(team_id) and author_id = auth.uid());

drop policy if exists chunks_select on chunks;
create policy chunks_select on chunks for select using (is_member(team_id));
drop policy if exists chunks_write on chunks;
create policy chunks_write on chunks for all
  using (is_member(team_id) and author_id = auth.uid())
  with check (is_member(team_id) and author_id = auth.uid());

-- exchange_metrics: INDIVIDUAL-ONLY (ADR 0008), enforced by the database —
-- not even your teammates can select your rows.
drop policy if exists metrics_self on exchange_metrics;
create policy metrics_self on exchange_metrics for all
  using (author_id = auth.uid())
  with check (author_id = auth.uid() and is_member(team_id));

-- asks: write as yourself; team-readable (deflection counts are team-visible).
drop policy if exists asks_select on asks;
create policy asks_select on asks for select using (is_member(team_id));
drop policy if exists asks_insert on asks;
create policy asks_insert on asks for insert
  with check (is_member(team_id) and author_id = auth.uid());

-- ---- RPCs (security definer: the only way to create/join teams) -------------

create or replace function create_team(p_name text, p_author text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_team uuid;
  v_code text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  insert into teams (name, owner_id) values (p_name, auth.uid()) returning id into v_team;
  insert into members (team_id, user_id, author_name, role)
    values (v_team, auth.uid(), p_author, 'owner');
  v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  insert into invites (code, team_id, created_by) values (v_code, v_team, auth.uid());
  return json_build_object('team_id', v_team, 'invite_code', v_code);
end;
$$;

create or replace function join_team(p_code text, p_author text)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_team uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select team_id into v_team from invites where code = p_code;
  if v_team is null then raise exception 'invalid invite code'; end if;
  insert into members (team_id, user_id, author_name, role)
    values (v_team, auth.uid(), p_author, 'member')
    on conflict (team_id, user_id) do update set author_name = excluded.author_name;
  return json_build_object('team_id', v_team);
end;
$$;

-- My memberships (the CLI's "which team am I on?").
create or replace function my_teams()
returns table (team_id uuid, team_name text, author_name text, role text, invite_code text)
language sql stable security definer set search_path = public as $$
  select m.team_id, t.name, m.author_name, m.role,
         (select code from invites i where i.team_id = m.team_id order by created_at desc limit 1)
  from members m join teams t on t.id = m.team_id
  where m.user_id = auth.uid();
$$;

-- ---- search (RLS applies through security invoker) ---------------------------

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
) language sql stable security invoker as $$
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
