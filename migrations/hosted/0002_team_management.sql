-- 0002_team_management.sql — RPCs backing the web app's Team page (D6).
--
-- The members table is RLS SELECT-only (writes go through SECURITY DEFINER
-- RPCs, same pattern as create_team/join_team in 0001). The web app needs
-- three new mutations, each gated here — never by the client:
--   * remove_member    — owner removes a teammate (not the owner)
--   * regenerate_invite — owner rotates the team's invite code (old ones die)
--   * rename_member     — anyone renames THEIR OWN roster display name
--
-- Deferred by design: role changes and ownership transfer (governance is
-- undefined for v1 — role is barely used today).

-- True iff the caller owns the team. security definer so it can read teams
-- without tripping that table's own policy.
create or replace function is_owner(t uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from teams where id = t and owner_id = auth.uid());
$$;

-- Owner removes a teammate. Cannot remove the owner (transfer/disband is a
-- separate, deferred flow). The teammate's sessions/chunks remain team data;
-- they simply lose access (is_member() now returns false for them).
create or replace function remove_member(p_team uuid, p_user uuid)
returns json language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not is_owner(p_team) then raise exception 'only the team owner can remove members'; end if;
  if exists (select 1 from teams where id = p_team and owner_id = p_user) then
    raise exception 'cannot remove the team owner';
  end if;
  delete from members where team_id = p_team and user_id = p_user;
  return json_build_object('removed', p_user);
end;
$$;

-- Owner rotates the invite code: delete existing codes for the team (so any
-- leaked code stops working) and mint a fresh one. Mirrors create_team's
-- 10-char generator.
create or replace function regenerate_invite(p_team uuid)
returns json language plpgsql security definer set search_path = public as $$
declare
  v_code text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if not is_owner(p_team) then raise exception 'only the team owner can regenerate the invite'; end if;
  delete from invites where team_id = p_team;
  v_code := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
  insert into invites (code, team_id, created_by) values (v_code, p_team, auth.uid());
  return json_build_object('invite_code', v_code);
end;
$$;

-- Rename your own roster display name. Self-only — the owner cannot rename
-- others. Only affects the members roster label; the author string captured
-- on past sessions/chunks is historical and unchanged.
create or replace function rename_member(p_team uuid, p_name text)
returns json language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  if length(coalesce(trim(p_name), '')) = 0 then raise exception 'name cannot be empty'; end if;
  update members set author_name = trim(p_name)
    where team_id = p_team and user_id = auth.uid();
  if not found then raise exception 'you are not a member of this team'; end if;
  return json_build_object('author_name', trim(p_name));
end;
$$;
