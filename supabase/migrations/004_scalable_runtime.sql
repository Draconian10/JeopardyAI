-- Apply after 003, before deploying the matching application. All data remains private.
begin;
create table public.session_presence (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  controller uuid,
  last_seen_ms bigint not null,
  primary key(session_id,user_id)
);
create table public.session_final_drafts (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  text text not null check(char_length(text)<=2000),
  revision bigint not null check(revision>=1),
  submitted_at_ms bigint,
  action_id uuid,
  primary key(session_id,user_id)
);
create table public.session_final_receipts (
  session_id uuid not null references public.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  action_id uuid not null,
  revision bigint not null,
  submitted_at_ms bigint not null,
  primary key(session_id,user_id,action_id)
);
alter table public.session_final_receipts enable row level security;
revoke all on public.session_final_receipts from public,anon,authenticated;
grant all on public.session_final_receipts to service_role;
alter table public.session_presence enable row level security;
alter table public.session_final_drafts enable row level security;
revoke all on public.session_presence, public.session_final_drafts from public,anon,authenticated;
grant all on public.session_presence, public.session_final_drafts to service_role;
insert into public.session_presence(session_id,user_id,controller,last_seen_ms)
 select id,host_id,nullif(state->>'controller','')::uuid,(state->>'hostSeen')::bigint from public.sessions;
insert into public.session_presence(session_id,user_id,last_seen_ms)
 select s.id,(p->>'id')::uuid,(p->>'lastSeen')::bigint from public.sessions s, lateral jsonb_array_elements(s.state->'players') p
 where not (p->>'removed')::boolean on conflict do nothing;
insert into public.session_final_drafts(session_id,user_id,text,revision,submitted_at_ms)
 select s.id,e.key::uuid,coalesce(e.value->>'text',''),greatest(coalesce((e.value->>'revision')::bigint,1),1),(e.value->>'submittedAt')::bigint
 from public.sessions s, lateral jsonb_each(s.state->'final') e
 where coalesce(e.value->>'text','')<>'' or e.value ? 'submittedAt';

insert into public.session_final_receipts(session_id,user_id,action_id,revision,submitted_at_ms)
 select s.id,(h->>'userId')::uuid,(h->>'actionId')::uuid,1,(h->>'at')::bigint
 from public.sessions s,lateral jsonb_array_elements(s.state->'history') h where h->>'type'='answer' on conflict do nothing;

create function public.hydrate_session_state(p_id uuid,p_state jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb:=p_state; presence public.session_presence%rowtype; entries jsonb; players jsonb;
begin
 select * into presence from public.session_presence where session_id=p_id and user_id=(p_state->>'hostId')::uuid;
 if found and presence.controller is not distinct from nullif(p_state->>'controller','')::uuid then
  result:=jsonb_set(result,'{hostSeen}',to_jsonb(greatest(presence.last_seen_ms,(p_state->>'hostSeen')::bigint)));
 end if;
 select coalesce(jsonb_agg(p || jsonb_build_object('lastSeen',greatest((p->>'lastSeen')::bigint,coalesce(x.last_seen_ms,0))) order by n),'[]'::jsonb)
 into players from jsonb_array_elements(p_state->'players') with ordinality q(p,n)
 left join public.session_presence x on x.session_id=p_id and x.user_id=(p->>'id')::uuid;
 result:=jsonb_set(result,'{players}',players);
 select coalesce(jsonb_object_agg(e.key,e.value || case when d.user_id is null then '{}'::jsonb else
  jsonb_strip_nulls(jsonb_build_object('text',d.text,'submittedAt',d.submitted_at_ms,'revision',d.revision)) end),'{}'::jsonb)
 into entries from jsonb_each(p_state->'final') e
 left join public.session_final_drafts d on d.session_id=p_id and d.user_id=e.key::uuid;
 return jsonb_set(result,'{final}',entries);
end;
$$;
create function public.read_session_runtime(p_id uuid)
returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('id',id,'state',public.hydrate_session_state(id,state),'pin_hash',pin_hash,'version',version,
 'runtimeAt',floor(extract(epoch from statement_timestamp())*1000)::bigint)
 from public.sessions where id=p_id
$$;

create function public.touch_session_presence(p_id uuid,p_user uuid,p_controller uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; t bigint; prior public.session_presence%rowtype;
begin
 -- Presence updates lock only this user's narrow row, never the game aggregate.
 insert into public.session_presence(session_id,user_id,last_seen_ms)
 select p_id,p_user,0 from public.sessions where id=p_id and (state->>'hostId'=p_user::text or exists(select 1 from jsonb_array_elements(state->'players') p where p->>'id'=p_user::text and not (p->>'removed')::boolean)) on conflict do nothing;
 select * into prior from public.session_presence where session_id=p_id and user_id=p_user for update;
 select state into s from public.sessions where id=p_id;
 if s is null then return jsonb_build_object('error','Session not found.','status',404); end if;
 if s->>'hostId'=p_user::text then
  if p_controller is null or p_controller::text is distinct from s->>'controller' then
   return jsonb_build_object('error','Another tab controls this game.','status',409);
  end if;
 elsif not exists(select 1 from jsonb_array_elements(s->'players') p where p->>'id'=p_user::text and not (p->>'removed')::boolean) then
  return jsonb_build_object('error','You do not have access to this session.','status',403);
 end if;
 t:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if s->>'hostId'=p_user::text and not (s->>'paused')::boolean and s->>'phase' not in ('finished','ended') and t>=greatest(coalesce(prior.last_seen_ms,0),(s->>'hostSeen')::bigint)+30000 then
  return jsonb_build_object('kind','heartbeat','serverNow',t,'host',true,'reconcile',true);
 end if;
 if s->>'phase' not in ('finished','ended') then
  update public.session_presence set last_seen_ms=greatest(last_seen_ms,t),controller=case when s->>'hostId'=p_user::text then p_controller else null end
  where session_id=p_id and user_id=p_user;
 end if;
 return jsonb_build_object('kind','heartbeat','serverNow',t,'host',s->>'hostId'=p_user::text);
end;
$$;

create function public.save_final_draft(p_id uuid,p_user uuid,p_text text,p_revision bigint,p_action uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; d public.session_final_drafts%rowtype; t bigint; changed boolean;
begin
 -- Shared aggregate locks permit all players to write separate drafts concurrently.
 -- A phase transition takes an exclusive lock and freezes all accepted drafts afterward.
 select state into s from public.sessions where id=p_id for share;
 if s is null then return jsonb_build_object('error','Session not found.','status',404); end if;
 if not exists(select 1 from jsonb_array_elements(s->'players') p where p->>'id'=p_user::text and not (p->>'removed')::boolean) then
  return jsonb_build_object('error','You do not have access to this session.','status',403);
 end if;
 if p_text is null or char_length(p_text)>2000 or p_action is null then
  return jsonb_build_object('error','Invalid response.','status',400);
 end if;
 -- Replays are harmless even after a phase boundary; new invalid writes cannot seed rows.
 select * into d from public.session_final_drafts where session_id=p_id and user_id=p_user;
 t:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if d.action_id=p_action or exists(select 1 from public.session_final_receipts where session_id=p_id and user_id=p_user and action_id=p_action) then
  return jsonb_build_object('kind','answer','serverNow',t,'text',d.text,'submittedAt',d.submitted_at_ms,'revision',d.revision);
 end if;
 if s->>'phase'<>'finalAnswer' or (s->>'paused')::boolean or not (s->'final' ? p_user::text)
 or (s->>'deadline')::bigint is null or t>=(s->>'deadline')::bigint then
  return jsonb_build_object('error','Responses are locked.','status',409);
 end if;
 -- Seed from legacy aggregate data once. Different players do not share a draft lock.
 insert into public.session_final_drafts(session_id,user_id,text,revision,submitted_at_ms)
 values(p_id,p_user,coalesce(s->'final'->p_user::text->>'text',''),1,(s->'final'->p_user::text->>'submittedAt')::bigint)
 on conflict do nothing;
 select * into d from public.session_final_drafts where session_id=p_id and user_id=p_user for update;
 t:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 if d.action_id=p_action or exists(select 1 from public.session_final_receipts where session_id=p_id and user_id=p_user and action_id=p_action) then
  return jsonb_build_object('kind','answer','serverNow',t,'text',d.text,'submittedAt',d.submitted_at_ms,'revision',d.revision);
 end if;
 s:=public.hydrate_session_state(p_id,s);
 if s->>'phase'<>'finalAnswer' or (s->>'paused')::boolean or not (s->'final' ? p_user::text)
 or (s->>'deadline')::bigint is null or t>=(s->>'deadline')::bigint then
  return jsonb_build_object('error','Responses are locked.','status',409);
 end if;
 if t>=(s->>'hostSeen')::bigint+30000 then
  return jsonb_build_object('error','Reconnecting to the host. Please retry.','status',409);
 end if;
 if p_revision is not null and (p_revision<=d.revision or p_revision>9007199254740991) then
  -- The initial empty seed is revision 1; a first client revision 1 is accepted only before a submission.
  if not (p_revision=1 and d.action_id is null and d.submitted_at_ms is null and d.text='') then
   return jsonb_build_object('error','A newer response is already saved. Please retry.','status',409);
  end if;
 end if;
 changed:=d.submitted_at_ms is null or (length(btrim(d.text))>0) is distinct from (length(btrim(p_text))>0);
 update public.session_final_drafts set text=p_text,revision=coalesce(p_revision,d.revision+1),submitted_at_ms=t,action_id=p_action
 where session_id=p_id and user_id=p_user returning * into d;
 insert into public.session_final_receipts(session_id,user_id,action_id,revision,submitted_at_ms)
 values(p_id,p_user,p_action,d.revision,t) on conflict do nothing;
 if changed then
  begin
   perform realtime.send(jsonb_build_object('submissionStatus',true),'changed','session:'||p_id::text,true);
  exception when others then raise warning 'Realtime notification skipped: %',sqlstate; end;
 end if;
 return jsonb_build_object('kind','answer','serverNow',t,'text',d.text,'submittedAt',t,'revision',d.revision,'statusChanged',changed);
end;
$$;

create or replace function public.commit_session(p_id uuid,p_expected integer,p_state jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
declare prior jsonb; hydrated jsonb; lease public.session_presence%rowtype; t bigint; old_members jsonb; new_members jsonb; last_action jsonb; legacy_entry jsonb; legacy_user uuid;
begin
 insert into public.session_presence(session_id,user_id,controller,last_seen_ms)
 select id,host_id,nullif(state->>'controller','')::uuid,(state->>'hostSeen')::bigint from public.sessions where id=p_id on conflict do nothing;
 -- Lease/controller handoff and aggregate reconciliation use the same narrow lock order.
 select p.* into lease from public.session_presence p join public.sessions s on s.id=p.session_id and s.host_id=p.user_id where p.session_id=p_id for update of p;
 select state into prior from public.sessions where id=p_id and version=p_expected for update;
 if not found then return false; end if;
 t:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
 hydrated:=public.hydrate_session_state(p_id,prior);
 if p_state->>'pauseReason'='Host disconnected' and (p_state->>'paused')::boolean and not (prior->>'paused')::boolean
 and t<(hydrated->>'hostSeen')::bigint+30000 then return false; end if;
 if not (p_state->>'paused')::boolean and p_state->>'phase' not in ('finished','ended')
 and p_state->>'controller' is not distinct from prior->>'controller'
 and (p_state->>'hostSeen')::bigint<=(hydrated->>'hostSeen')::bigint
 and t>=(hydrated->>'hostSeen')::bigint+30000 then return false; end if;
 if prior->>'phase' in ('question','practiceOpen','tieQuestion') and p_state->>'phase' in ('answering','practiceAnswer','tieAnswer')
 and t>=(prior->>'deadline')::bigint then return false; end if;
 if p_state->>'phase'='finalAnswer' and not (p_state->>'paused')::boolean and t>=(p_state->>'deadline')::bigint then return false; end if;
 -- Support the previous deployment's aggregate-based saves during migration-first rollout.
 last_action:=p_state->'history'->-1;
 if last_action->>'type'='answer' and prior->>'phase'='finalAnswer' and p_state->>'phase'='finalAnswer' then
  legacy_user:=(last_action->>'userId')::uuid;
  legacy_entry:=p_state->'final'->legacy_user::text;
  if legacy_entry is distinct from prior->'final'->legacy_user::text and not exists(select 1 from public.session_final_receipts where session_id=p_id and user_id=legacy_user and action_id=(last_action->>'actionId')::uuid) then
   if (prior->>'paused')::boolean or t>=(prior->>'deadline')::bigint then return false; end if;
   insert into public.session_final_drafts(session_id,user_id,text,revision,submitted_at_ms,action_id)
   values(p_id,legacy_user,legacy_entry->>'text',greatest(coalesce((legacy_entry->>'revision')::bigint,1),1),(legacy_entry->>'submittedAt')::bigint,(last_action->>'actionId')::uuid)
   on conflict(session_id,user_id) do update set text=excluded.text,revision=public.session_final_drafts.revision+1,
    submitted_at_ms=excluded.submitted_at_ms,action_id=excluded.action_id
   where public.session_final_drafts.submitted_at_ms is null or excluded.submitted_at_ms>=public.session_final_drafts.submitted_at_ms;
   if not found then return false; end if;
   insert into public.session_final_receipts(session_id,user_id,action_id,revision,submitted_at_ms)
   select p_id,legacy_user,(last_action->>'actionId')::uuid,revision,coalesce(submitted_at_ms,t) from public.session_final_drafts where session_id=p_id and user_id=legacy_user on conflict do nothing;
  end if;
 end if;
 -- Read latest drafts while holding the exclusive phase boundary, preventing freeze races.
 p_state:=public.hydrate_session_state(p_id,p_state);
 update public.sessions set state=p_state,version=p_expected+1,active=(p_state->>'phase') not in ('finished','ended') where id=p_id;
 select coalesce(jsonb_agg(id order by id),'[]') into old_members from (
  select prior->>'hostId' id union select p->>'id' from jsonb_array_elements(prior->'players') p where not (p->>'removed')::boolean) x;
 select coalesce(jsonb_agg(id order by id),'[]') into new_members from (
  select p_state->>'hostId' id union select p->>'id' from jsonb_array_elements(p_state->'players') p where not (p->>'removed')::boolean) x;
 if old_members is distinct from new_members or not exists(select 1 from public.session_members where session_id=p_id) then
  delete from public.session_members where session_id=p_id;
  insert into public.session_members(session_id,user_id) select p_id,value::uuid from jsonb_array_elements_text(new_members);
 end if;
 if lease.controller is distinct from nullif(p_state->>'controller','')::uuid or (p_state->>'hostSeen')::bigint>lease.last_seen_ms then
  update public.session_presence set controller=nullif(p_state->>'controller','')::uuid,last_seen_ms=greatest(lease.last_seen_ms,(p_state->>'hostSeen')::bigint,t)
  where session_id=p_id and user_id=(p_state->>'hostId')::uuid;
 end if;
 begin perform realtime.send(jsonb_build_object('version',p_expected+1),'changed','session:'||p_id::text,true);
 exception when others then raise warning 'Realtime notification skipped: %',sqlstate; end;
 return true;
end;
$$;

-- A conditional claim rejects losing buzzes without a retry storm. Engine validation still runs first.
create function public.claim_session_buzz(p_id uuid,p_expected integer,p_window uuid,p_user uuid,p_state jsonb)
returns boolean language plpgsql security definer set search_path='' as $$
begin
 if p_state->>'respondent' is distinct from p_user::text then return false; end if;
 if not exists(select 1 from public.sessions s where s.id=p_id and s.version=p_expected
 and s.state->>'phase' in ('question','practiceOpen','tieQuestion') and s.state->>'windowId'=p_window::text
 and s.state->>'respondent' is null and not (coalesce(s.state->'attempted','[]') ? p_user::text)
 and (s.state->>'phase'<>'tieQuestion' or s.state->'tiebreaker'->'playerIds' ? p_user::text)
 and p_state->>'phase'=case s.state->>'phase' when 'practiceOpen' then 'practiceAnswer' when 'tieQuestion' then 'tieAnswer' else 'answering' end
 and not (s.state->>'paused')::boolean and exists(select 1 from jsonb_array_elements(s.state->'players') p where p->>'id'=p_user::text and not (p->>'removed')::boolean)) then return false; end if;
 return public.commit_session(p_id,p_expected,p_state);
end;
$$;
revoke all on function public.hydrate_session_state(uuid,jsonb),public.read_session_runtime(uuid),public.touch_session_presence(uuid,uuid,uuid),public.save_final_draft(uuid,uuid,text,bigint,uuid),public.claim_session_buzz(uuid,integer,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.hydrate_session_state(uuid,jsonb),public.read_session_runtime(uuid),public.touch_session_presence(uuid,uuid,uuid),public.save_final_draft(uuid,uuid,text,bigint,uuid),public.claim_session_buzz(uuid,integer,uuid,uuid,jsonb) to service_role;
notify pgrst, 'reload schema';
commit;
