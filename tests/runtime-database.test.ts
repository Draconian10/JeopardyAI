import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applyCommand, createSession } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
import type { Session } from '@/lib/game/types';
const pg = new PGlite();
const HOST = crypto.randomUUID(),
  CONTROL = crypto.randomUUID(),
  GAME = crypto.randomUUID();
const players = Array.from({ length: 15 }, () => crypto.randomUUID());
let code = 100000;
beforeAll(async () => {
  await pg.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth; create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
 grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
 create schema realtime; create table realtime.messages(id bigserial,extension text,topic text,payload jsonb);
 alter table realtime.messages enable row level security; grant usage on schema realtime to authenticated; grant select on realtime.messages to authenticated;
 create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
 create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$ insert into realtime.messages(extension,topic,payload) values('broadcast',topic,payload) $$;`);
  for (const f of ['001_initial.sql', '002_question_json.sql', '003_saved_tiebreakers.sql'])
    await pg.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
  for (const id of [HOST, ...players]) await pg.query('insert into auth.users values($1)', [id]);
  await pg.query('insert into public.games(id,owner_id,board,pin_hash) values($1,$2,$3,$4)', [
    GAME,
    HOST,
    JSON.stringify(starterBoard()),
    'test',
  ]);
  // Apply after an in-progress legacy game already has a response.
  const legacy = await seed();
  legacy.final[players[0]].text = 'Legacy response';
  legacy.final[players[0]].submittedAt = Date.now();
  await pg.query('update public.sessions set state=$2 where id=$1', [
    legacy.id,
    JSON.stringify(legacy),
  ]);
  await pg.exec(readFileSync('supabase/migrations/004_scalable_runtime.sql', 'utf8'));
}, 30000);
afterAll(() => pg.close());
async function seed() {
  const s = createSession(starterBoard(), GAME, HOST, String(code++), Date.now(), CONTROL);
  s.players = players.map((id, i) => ({
    id,
    name: `Player ${i}`,
    score: 1000,
    lastSeen: Date.now(),
    removed: false,
  }));
  s.phase = 'finalAnswer';
  s.deadline = Date.now() + 30000;
  s.final = Object.fromEntries(players.map((id) => [id, { score: 1000, wager: 100, text: '' }]));
  await pg.query(
    'insert into public.sessions(id,game_id,host_id,join_code,state,pin_hash) values($1,$2,$3,$4,$5,$6)',
    [s.id, GAME, HOST, s.joinCode, JSON.stringify(s), 'test'],
  );
  return s;
}
async function runtime(id: string) {
  return (
    await pg.query<{ r: { state: Session; version: number } }>(
      'select public.read_session_runtime($1) r',
      [id],
    )
  ).rows[0].r;
}
async function draft(
  id: string,
  user: string,
  text: string,
  revision = 1,
  action = crypto.randomUUID(),
) {
  return (
    await pg.query<{
      r: { kind?: string; error?: string; status?: number; revision: number; submittedAt: number };
    }>('select public.save_final_draft($1,$2,$3,$4,$5) r', [id, user, text, revision, action])
  ).rows[0].r;
}
async function touch(s: Session, user = HOST, controller: string | null = CONTROL) {
  return (
    await pg.query<{ r: { kind?: string; error?: string; reconcile?: boolean; status?: number } }>(
      'select public.touch_session_presence($1,$2,$3) r',
      [s.id, user, controller],
    )
  ).rows[0].r;
}
async function notifications(id: string) {
  return (await pg.query('select id from realtime.messages where topic=$1', [`session:${id}`])).rows
    .length;
}
async function commit(before: Session, next: Session) {
  return (
    await pg.query<{ ok: boolean }>('select public.commit_session($1,$2,$3) ok', [
      before.id,
      before.version,
      JSON.stringify(next),
    ])
  ).rows[0].ok;
}
describe('scalable durable runtime', () => {
  it('backfills existing response and host lease records', async () => {
    const rows = await pg.query<{ state: Session }>(
      'select state from public.sessions order by join_code limit 1',
    );
    const loaded = await runtime(rows.rows[0].state.id);
    expect(loaded.state.final[players[0]].text).toBe('Legacy response');
    expect(
      (
        await pg.query('select * from public.session_presence where session_id=$1', [
          loaded.state.id,
        ])
      ).rows,
    ).toHaveLength(16);
  });
  it('heartbeats never rewrite the aggregate, member rows or broadcast', async () => {
    const s = await seed();
    const before = (await runtime(s.id)).state;
    const initial = await notifications(s.id);
    expect((await touch(s)).kind).toBe('heartbeat');
    await Promise.all(players.map((id) => touch(s, id, null)));
    const raw = (
      await pg.query<{ state: Session; version: number }>(
        'select state,version from public.sessions where id=$1',
        [s.id],
      )
    ).rows[0];
    expect(raw.state).toEqual(before);
    expect(raw.version).toBe(0);
    expect(await notifications(s.id)).toBe(initial);
    expect((await runtime(s.id)).state.hostSeen).toBeGreaterThanOrEqual(before.hostSeen);
  });
  it('accepts fifteen concurrent drafts without changing game versions and only notifies status transitions', async () => {
    const s = await seed();
    const first = await Promise.all(players.map((id, i) => draft(s.id, id, `Response ${i}`)));
    expect(first.every((r) => r.kind === 'answer')).toBe(true);
    expect(await notifications(s.id)).toBe(15);
    const second = await Promise.all(players.map((id, i) => draft(s.id, id, `Edited ${i}`, 2)));
    expect(second.every((r) => r.kind === 'answer')).toBe(true);
    expect(await notifications(s.id)).toBe(15);
    const loaded = await runtime(s.id);
    expect(loaded.version).toBe(0);
    expect(loaded.state.history).toEqual([]);
    expect(Object.values(loaded.state.final).filter((e) => e.text)).toHaveLength(15);
    const raw = (
      await pg.query<{ state: Session }>('select state from public.sessions where id=$1', [s.id])
    ).rows[0].state;
    expect(Object.values(raw.final).every((e) => e.text === '')).toBe(true);
    await draft(s.id, players[0], '', 3);
    expect(await notifications(s.id)).toBe(16);
  });
  it('rejects stale revisions, paused/late/foreign writes and accepts idempotent retries', async () => {
    const s = await seed(),
      action = crypto.randomUUID();
    const saved = await draft(s.id, players[0], 'Latest', 2, action);
    expect((await draft(s.id, players[0], 'Stale', 1)).status).toBe(409);
    expect(await draft(s.id, players[0], 'Ignored replay payload', 2, action)).toMatchObject({
      revision: saved.revision,
      submittedAt: saved.submittedAt,
    });
    expect((await draft(s.id, HOST, 'Forbidden')).status).toBe(403);
    expect((await draft(s.id, players[1], 'x'.repeat(2001))).status).toBe(400);
    s.paused = true;
    await pg.query('update public.sessions set state=$2 where id=$1', [s.id, JSON.stringify(s)]);
    expect((await draft(s.id, players[1], 'Paused')).status).toBe(409);
    s.paused = false;
    s.deadline = Date.now() - 1;
    await pg.query('update public.sessions set state=$2 where id=$1', [s.id, JSON.stringify(s)]);
    expect((await draft(s.id, players[1], 'Late')).status).toBe(409);
    expect((await draft(s.id, players[0], 'Replay', 2, action)).kind).toBe('answer');
  });
  it('freezes the latest accepted draft even when the transition was computed from an older snapshot', async () => {
    const s = await seed();
    const next = {
      ...s,
      phase: 'finalReveal' as const,
      deadline: undefined,
      remaining: 0,
      version: 1,
      actionVersion: 1,
    };
    await draft(s.id, players[0], 'Accepted after the host snapshot');
    expect(await commit(s, next)).toBe(true);
    const raw = (
      await pg.query<{ state: Session }>('select state from public.sessions where id=$1', [s.id])
    ).rows[0].state;
    expect(raw.final[players[0]].text).toBe('Accepted after the host snapshot');
    expect((await draft(s.id, players[0], 'Too late', 2)).status).toBe(409);
  });
  it('invalidates the old controller at handoff and rejects stale false-disconnect reconciliation', async () => {
    const s = await seed();
    await touch(s);
    const stale = {
      ...s,
      paused: true,
      pauseReason: 'Host disconnected',
      version: 1,
      actionVersion: 1,
    };
    expect(await commit(s, stale)).toBe(false);
    const newController = crypto.randomUUID();
    const claimed = applyCommand(
      (await runtime(s.id)).state,
      { type: 'claim', pin: '123456', controller: newController },
      {
        userId: HOST,
        controller: CONTROL,
        now: Date.now(),
        actionId: crypto.randomUUID(),
        expectedVersion: 0,
        pinVerified: true,
      },
    );
    expect(await commit(s, claimed)).toBe(true);
    expect((await touch(s, HOST, CONTROL)).status).toBe(409);
    expect((await touch(s, HOST, newController)).kind).toBe('heartbeat');
  });
  it('does not let a late heartbeat silently skip the original lease-loss pause', async () => {
    const s = await seed();
    s.hostSeen = Date.now() - 31000;
    s.deadline = Date.now() + 15000;
    await pg.query('update public.sessions set state=$2 where id=$1', [s.id, JSON.stringify(s)]);
    expect((await touch(s)).reconcile).toBe(true);
    expect((await runtime(s.id)).state.hostSeen).toBe(s.hostSeen);
  });
  it('never overwrites a newer draft when an older accepted action is replayed', async () => {
    const s = await seed(),
      oldAction = crypto.randomUUID();
    await draft(s.id, players[0], 'First', 1, oldAction);
    await draft(s.id, players[0], 'Second', 2);
    const replay = await draft(s.id, players[0], 'First replayed', 1, oldAction);
    expect(replay.revision).toBe(2);
    expect((await runtime(s.id)).state.final[players[0]].text).toBe('Second');
    const legacyReplay = await pg.query<{ r: { revision: number } }>(
      'select public.save_final_draft($1,$2,$3,null,$4) r',
      [s.id, players[0], 'Missing legacy revision', oldAction],
    );
    expect(legacyReplay.rows[0].r.revision).toBe(2);
    expect((await runtime(s.id)).state.final[players[0]].text).toBe('Second');
  });
  it('rejects a stale legacy save instead of acknowledging text overwritten by a newer draft', async () => {
    const before = await seed();
    await draft(before.id, players[0], 'Newer accepted response');
    const legacy = applyCommand(
      before,
      { type: 'answer', text: 'Earlier request' },
      {
        userId: players[0],
        now: Date.now() - 100,
        actionId: crypto.randomUUID(),
        expectedVersion: before.actionVersion,
      },
    );
    expect(await commit(before, legacy)).toBe(false);
    expect((await runtime(before.id)).state.final[players[0]].text).toBe('Newer accepted response');
  });
  it('keeps old aggregate-based Final saves compatible during migration-first rollout', async () => {
    const before = await seed();
    const legacy = applyCommand(
      before,
      { type: 'answer', text: 'Saved by previous deployment' },
      {
        userId: players[0],
        now: Date.now(),
        actionId: crypto.randomUUID(),
        expectedVersion: before.actionVersion,
      },
    );
    expect(await commit(before, legacy)).toBe(true);
    const restored = await runtime(before.id);
    expect(restored.state.final[players[0]].text).toBe('Saved by previous deployment');
    expect(restored.state.final[players[0]].submittedAt).toBeGreaterThan(0);
  });
  it('preserves private drafts and membership through a pause and resume', async () => {
    const before = await seed();
    await draft(before.id, players[0], 'Before pause');
    const snapshot = (await runtime(before.id)).state;
    const paused = applyCommand(
      snapshot,
      { type: 'pause' },
      {
        userId: HOST,
        controller: CONTROL,
        now: Date.now(),
        actionId: crypto.randomUUID(),
        expectedVersion: snapshot.actionVersion,
      },
    );
    expect(await commit(snapshot, paused)).toBe(true);
    const members = await pg.query<{ user_id: string; ctid: string }>(
      'select user_id,ctid::text from public.session_members where session_id=$1 order by user_id',
      [before.id],
    );
    expect((await draft(before.id, players[0], 'Not accepted', 2)).status).toBe(409);
    const current = (await runtime(before.id)).state;
    const continued = applyCommand(
      current,
      { type: 'continue' },
      {
        userId: HOST,
        controller: CONTROL,
        now: Date.now(),
        actionId: crypto.randomUUID(),
        expectedVersion: current.actionVersion,
      },
    );
    expect(await commit(current, continued)).toBe(true);
    expect((await draft(before.id, players[0], 'After resume', 2)).kind).toBe('answer');
    expect((await runtime(before.id)).state.final[players[0]].text).toBe('After resume');
    expect(
      (
        await pg.query(
          'select user_id,ctid::text from public.session_members where session_id=$1 order by user_id',
          [before.id],
        )
      ).rows,
    ).toEqual(members.rows);
  });
  it('denies browser reads and execution of every privileged runtime function', async () => {
    const s = await seed();
    await pg.exec('set role authenticated');
    try {
      for (const sql of [
        'select * from public.session_presence',
        'select * from public.session_final_drafts',
        'select * from public.session_final_receipts',
        `select public.read_session_runtime('${s.id}')`,
        `select public.touch_session_presence('${s.id}','${HOST}','${CONTROL}')`,
        `select public.save_final_draft('${s.id}','${players[0]}','x',1,gen_random_uuid())`,
        `select public.claim_session_buzz('${s.id}',0,gen_random_uuid(),'${players[0]}','{}')`,
      ])
        await expect(pg.query(sql)).rejects.toThrow('permission denied');
    } finally {
      await pg.exec('reset role');
    }
  });
});
