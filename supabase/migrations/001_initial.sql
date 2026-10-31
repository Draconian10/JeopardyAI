-- Apply once in the Supabase SQL editor, or with supabase db push.
create table public.games (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  board jsonb not null,
  pin_hash text not null,
  version integer not null default 0,
  archived boolean not null default false,
  updated_at timestamptz not null default now()
);
create table public.sessions (
  id uuid primary key,
  game_id uuid not null references public.games(id),
  host_id uuid not null references auth.users(id),
  join_code text not null check (join_code ~ '^\d{6}$'),
  active boolean not null default true,
  version integer not null default 0,
  state jsonb not null,
  pin_hash text not null,
  created_at timestamptz not null default now()
);
create unique index active_join_code on public.sessions(join_code) where active;
create index sessions_host on public.sessions(host_id, created_at desc);
create index games_owner on public.games(owner_id);
create table public.session_members (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  primary key(session_id, user_id)
);
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  attempts integer not null
);
grant all on public.games, public.sessions, public.session_members, public.rate_limits to service_role;
alter table public.games enable row level security;
alter table public.sessions enable row level security;
alter table public.session_members enable row level security;
alter table public.rate_limits enable row level security;
-- No direct browser access to game/session JSON: it contains private answers.
revoke all on public.games, public.sessions, public.rate_limits from anon, authenticated;
revoke all on public.session_members from anon, authenticated;
grant select on public.session_members to authenticated;
create policy own_membership on public.session_members for select to authenticated using (user_id = (select auth.uid()));

-- One compare-and-swap transaction serializes buzzer claims and all other changes.
create function public.commit_session(p_id uuid, p_expected integer, p_state jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare changed integer;
begin
  update public.sessions set state=p_state, version=p_expected+1,
    active = (p_state->>'phase') not in ('finished','ended')
    where id=p_id and version=p_expected;
  get diagnostics changed = row_count;
  if changed=0 then return false; end if;
  delete from public.session_members where session_id=p_id;
  insert into public.session_members(session_id,user_id)
    select p_id, (p_state->>'hostId')::uuid
    union
    select p_id, (p->>'id')::uuid from jsonb_array_elements(p_state->'players') p where not (p->>'removed')::boolean;
  -- Only a version notification is broadcast. Clients fetch their authorized projection.
  begin
    perform realtime.send(jsonb_build_object('version',p_expected+1),'changed','session:'||p_id::text,true);
  exception when others then
    -- A notification outage must never roll back an accepted buzz or score.
    -- Browsers reconcile via the authenticated polling fallback.
    raise warning 'Realtime notification skipped: %', sqlstate;
  end;
  return true;
end;
$$;
revoke all on function public.commit_session(uuid,integer,jsonb) from public, anon, authenticated;
grant execute on function public.commit_session(uuid,integer,jsonb) to service_role;

create function public.consume_rate_limit(p_key text, p_limit integer, p_seconds integer)
returns boolean language plpgsql security definer set search_path = '' as $$
declare hits integer;
begin
  insert into public.rate_limits as r(key,window_start,attempts) values(p_key,now(),1)
  on conflict(key) do update set
    attempts=case when r.window_start < now()-make_interval(secs=>p_seconds) then 1 else r.attempts+1 end,
    window_start=case when r.window_start < now()-make_interval(secs=>p_seconds) then now() else r.window_start end
  returning attempts into hits;
  return hits<=p_limit;
end;
$$;
revoke all on function public.consume_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.consume_rate_limit(text,integer,integer) to service_role;

create policy session_notifications on realtime.messages for select to authenticated using (
  extension='broadcast' and topic=realtime.topic() and exists (
    select 1 from public.session_members m where m.user_id=(select auth.uid())
    and ('session:'||m.session_id::text)=realtime.topic()
  )
);
-- No client INSERT policy: clients cannot forge authoritative broadcasts.

-- Serialize session launches per saved board. Idempotent retries return the same
-- session; a second independent launch requires explicit separate-session intent.
create function public.launch_session(p_state jsonb, p_pin_hash text, p_separate boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  game_uuid uuid := (p_state->>'gameId')::uuid;
  session_uuid uuid := (p_state->>'id')::uuid;
  host_uuid uuid := (p_state->>'hostId')::uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(game_uuid::text,0));
  if not exists(select 1 from public.games where id=game_uuid and owner_id=host_uuid and not archived) then
    raise exception 'Game is unavailable or archived.';
  end if;
  if exists(select 1 from public.sessions where id=session_uuid and host_id=host_uuid and game_id=game_uuid) then
    return session_uuid;
  end if;
  if not p_separate and exists(select 1 from public.sessions where game_id=game_uuid and active) then
    raise exception 'An unfinished session exists. Resume it or explicitly start a separate session.';
  end if;
  insert into public.sessions(id,game_id,host_id,join_code,state,pin_hash)
    values(session_uuid,game_uuid,host_uuid,p_state->>'joinCode',p_state,p_pin_hash);
  insert into public.session_members(session_id,user_id) values(session_uuid,host_uuid);
  return session_uuid;
end;
$$;
revoke all on function public.launch_session(jsonb,text,boolean) from public, anon, authenticated;
grant execute on function public.launch_session(jsonb,text,boolean) to service_role;
