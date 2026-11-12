-- Host-approved player recovery and expiring, read-only audience access.
-- Apply after 004_scalable_runtime.sql before deploying the application.
begin;

create table public.session_player_recovery_codes (
  session_id uuid not null references public.sessions(id) on delete cascade,
  player_id uuid not null references auth.users(id),
  code_hash text not null check (char_length(code_hash)=64),
  expires_at timestamptz not null,
  primary key (session_id, player_id)
);
create table public.session_player_recovery_requests (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  player_id uuid not null references auth.users(id),
  claimant_id uuid not null references auth.users(id),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz
);
create index session_recovery_pending on public.session_player_recovery_requests(session_id,requested_at)
  where status='pending';
create index session_recovery_claimants on public.session_player_recovery_requests(claimant_id,requested_at desc);
create table public.session_display_links (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  token_hash text not null check (char_length(token_hash)=64),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.session_player_recovery_codes enable row level security;
alter table public.session_player_recovery_requests enable row level security;
alter table public.session_display_links enable row level security;
revoke all on public.session_player_recovery_codes, public.session_player_recovery_requests,
  public.session_display_links from public, anon, authenticated;
grant all on public.session_player_recovery_codes, public.session_player_recovery_requests,
  public.session_display_links to service_role;

-- Replaces exact player UUID values and object keys throughout the aggregate.
-- This preserves score history, selector/response ownership, Final entries and undo checkpoints.
create function public.replace_player_identity(p_value jsonb,p_old text,p_new text)
returns jsonb language plpgsql immutable strict set search_path='' as $$
declare kind text := jsonb_typeof(p_value); output jsonb;
begin
  if kind='string' then
    if p_value=to_jsonb(p_old) then return to_jsonb(p_new); end if;
    return p_value;
  elsif kind='array' then
    select coalesce(jsonb_agg(public.replace_player_identity(v,p_old,p_new) order by n),'[]'::jsonb)
      into output from jsonb_array_elements(p_value) with ordinality a(v,n);
    return output;
  elsif kind='object' then
    select coalesce(jsonb_object_agg(case when k=p_old then p_new else k end,
      public.replace_player_identity(v,p_old,p_new)),'{}'::jsonb)
      into output from jsonb_each(p_value) a(k,v);
    return output;
  end if;
  return p_value;
end;
$$;

-- Code rotation also cancels outstanding claims using the previous secret.
-- Taking the session lock serializes it with host-approved seat transfers.
create function public.rotate_player_recovery_code(
  p_session uuid,p_player uuid,p_hash text,p_expires timestamptz
) returns boolean language plpgsql security definer set search_path='' as $
declare s public.sessions%rowtype;
begin
  select * into s from public.sessions where id=p_session for update;
  if not found or not s.active or char_length(p_hash)<>64
    or not exists(select 1 from jsonb_array_elements(s.state->'players') p
      where p->>'id'=p_player::text and not (p->>'removed')::boolean) then
    return false;
  end if;
  insert into public.session_player_recovery_codes(session_id,player_id,code_hash,expires_at)
    values(p_session,p_player,p_hash,p_expires)
    on conflict(session_id,player_id) do update
      set code_hash=excluded.code_hash,expires_at=excluded.expires_at;
  update public.session_player_recovery_requests
    set status='rejected',resolved_at=clock_timestamp()
    where session_id=p_session and player_id=p_player and status='pending';
  return true;
end;
$;

-- Atomic: serializes against game commits and Final draft writes by locking the
-- host lease and aggregate; no in-flight command can overwrite the transferred seat.
create function public.approve_player_recovery(p_session uuid,p_host uuid,p_request uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.sessions%rowtype; r public.session_player_recovery_requests%rowtype;
        next_state jsonb; hydrated jsonb; now_ms bigint;
begin
  perform 1 from public.session_presence where session_id=p_session and user_id=p_host for update;
  select * into s from public.sessions where id=p_session for update;
  if not found or s.host_id<>p_host then
    return jsonb_build_object('error','Only this game host can approve recovery.','status',403);
  end if;
  if not s.active then
    return jsonb_build_object('error','This game has already ended.','status',409);
  end if;
  select * into r from public.session_player_recovery_requests
    where id=p_request and session_id=p_session for update;
  if not found or r.status<>'pending' or r.expires_at<=clock_timestamp() then
    return jsonb_build_object('error','Recovery request expired or already resolved.','status',409);
  end if;
  if not exists(select 1 from jsonb_array_elements(s.state->'players') p
    where p->>'id'=r.player_id::text and not (p->>'removed')::boolean)
    or r.claimant_id=p_host
    or exists(select 1 from jsonb_array_elements(s.state->'players') p where p->>'id'=r.claimant_id::text) then
    return jsonb_build_object('error','That player seat is no longer recoverable.','status',409);
  end if;

  hydrated:=public.hydrate_session_state(p_session,s.state);
  now_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  next_state:=public.replace_player_identity(hydrated,r.player_id::text,r.claimant_id::text);
  next_state:=jsonb_set(next_state,'{version}',to_jsonb(s.version+1));
  next_state:=jsonb_set(next_state,'{actionVersion}',to_jsonb((s.state->>'actionVersion')::integer+1));
  next_state:=jsonb_set(next_state,'{updatedAt}',to_jsonb(now_ms));
  update public.sessions set state=next_state,version=s.version+1 where id=p_session;
  update public.session_final_drafts set user_id=r.claimant_id
    where session_id=p_session and user_id=r.player_id;
  update public.session_final_receipts set user_id=r.claimant_id
    where session_id=p_session and user_id=r.player_id;
  update public.session_presence set user_id=r.claimant_id,last_seen_ms=now_ms,controller=null
    where session_id=p_session and user_id=r.player_id;
  insert into public.session_presence(session_id,user_id,last_seen_ms)
    values(p_session,r.claimant_id,now_ms) on conflict (session_id,user_id)
    do update set last_seen_ms=excluded.last_seen_ms;
  delete from public.session_members where session_id=p_session and user_id=r.player_id;
  insert into public.session_members(session_id,user_id) values(p_session,r.claimant_id) on conflict do nothing;
  delete from public.session_player_recovery_codes
    where session_id=p_session and player_id=r.player_id;
  update public.session_player_recovery_requests set status='rejected',resolved_at=clock_timestamp()
    where session_id=p_session and player_id=r.player_id and status='pending' and id<>p_request;
  update public.session_player_recovery_requests set status='approved',resolved_at=clock_timestamp()
    where id=p_request;
  begin
    perform realtime.send(jsonb_build_object('version',s.version+1),'changed','session:'||p_session::text,true);
  exception when others then raise warning 'Realtime recovery notification skipped: %',sqlstate; end;
  return jsonb_build_object('approved',true,'sessionId',p_session);
end;
$$;

revoke all on function public.replace_player_identity(jsonb,text,text),
  public.approve_player_recovery(uuid,uuid,uuid),
  public.rotate_player_recovery_code(uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.replace_player_identity(jsonb,text,text),
  public.approve_player_recovery(uuid,uuid,uuid),
  public.rotate_player_recovery_code(uuid,uuid,text,timestamptz) to service_role;

notify pgrst, 'reload schema';
commit;
