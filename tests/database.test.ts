import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { applyCommand, createSession } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
const pg = new PGlite();
const HOST = crypto.randomUUID(),
  PLAYER = crypto.randomUUID(),
  GAME = crypto.randomUUID(),
  CONTROLLER = crypto.randomUUID();
beforeAll(async () => {
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create schema realtime; create table realtime.messages(id bigserial, extension text, topic text, payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated;
    grant select on realtime.messages to authenticated;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$ insert into realtime.messages(extension,topic,payload) values('broadcast',topic,payload) $$;
  `);
  await pg.exec(readFileSync('supabase/migrations/001_initial.sql', 'utf8'));
  await pg.query('insert into auth.users(id) values ($1),($2)', [HOST, PLAYER]);
  await pg.query('insert into public.games(id,owner_id,board,pin_hash) values ($1,$2,$3,$4)', [
    GAME,
    HOST,
    JSON.stringify(starterBoard()),
    'test-hash',
  ]);
}, 30000);
afterAll(async () => {
  await pg.close();
});
async function insertSession(code = '123456') {
  const s = createSession(starterBoard(), GAME, HOST, code, Date.now());
  await pg.query(
    'insert into public.sessions(id,game_id,host_id,join_code,state,pin_hash) values ($1,$2,$3,$4,$5,$6)',
    [s.id, GAME, HOST, code, JSON.stringify(s), 'test-hash'],
  );
  return s;
}
describe('PostgreSQL persistence and authorization', () => {
  it('allows one winner for competing compare-and-swap commits and persists membership', async () => {
    const s = await insertSession();
    const one = applyCommand(
      s,
      { type: 'join', name: 'Alex' },
      {
        userId: PLAYER,
        now: Date.now(),
        actionId: crypto.randomUUID(),
        controller: CONTROLLER,
        expectedVersion: 0,
      },
    );
    const first = await pg.query<{ ok: boolean }>('select public.commit_session($1,$2,$3) as ok', [
      s.id,
      0,
      JSON.stringify(one),
    ]);
    const second = await pg.query<{ ok: boolean }>('select public.commit_session($1,$2,$3) as ok', [
      s.id,
      0,
      JSON.stringify({ ...one, title: 'Losing write' }),
    ]);
    expect(first.rows[0].ok).toBe(true);
    expect(second.rows[0].ok).toBe(false);
    const saved = await pg.query<{ state: { title: string }; version: number }>(
      'select state,version from public.sessions where id=$1',
      [s.id],
    );
    expect(saved.rows[0].state.title).toBe(s.title);
    expect(saved.rows[0].version).toBe(1);
    const members = await pg.query(
      'select user_id from public.session_members where session_id=$1',
      [s.id],
    );
    expect(members.rows).toHaveLength(2);
    const notification = await pg.query<{ payload: unknown }>(
      'select payload from realtime.messages where topic=$1',
      [`session:${s.id}`],
    );
    expect(notification.rows[0].payload).toEqual({ version: 1 });
  });
  it('enforces uniqueness of active join codes but allows reuse after explicit end', async () => {
    const s = await insertSession('000001');
    await expect(insertSession('000001')).rejects.toThrow();
    await pg.query('update public.sessions set active=false where id=$1', [s.id]);
    await expect(insertSession('000001')).resolves.toBeTruthy();
  });
  it('denies direct browser access to private session and game content', async () => {
    await pg.exec('set role authenticated');
    try {
      await expect(pg.query('select state from public.sessions')).rejects.toThrow(
        'permission denied',
      );
      await expect(pg.query('select pin_hash from public.games')).rejects.toThrow(
        'permission denied',
      );
    } finally {
      await pg.exec('reset role');
    }
  });
  it('denies browser execution of privileged commit and rate-limit functions', async () => {
    await pg.exec('set role authenticated');
    try {
      await expect(
        pg.query("select public.commit_session(gen_random_uuid(),0,'{}')"),
      ).rejects.toThrow('permission denied');
      await expect(pg.query("select public.consume_rate_limit('bypass',10,60)")).rejects.toThrow(
        'permission denied',
      );
    } finally {
      await pg.exec('reset role');
    }
  });
  it('only permits members to read the matching realtime channel', async () => {
    const s = await insertSession('333333');
    const next = applyCommand(
      s,
      { type: 'join', name: 'Alex' },
      { userId: PLAYER, now: Date.now(), actionId: crypto.randomUUID(), expectedVersion: 0 },
    );
    await pg.query('select public.commit_session($1,0,$2)', [s.id, JSON.stringify(next)]);
    await pg.query(
      "select set_config('request.jwt.claim.sub',$1,false),set_config('realtime.topic',$2,false)",
      [PLAYER, `session:${s.id}`],
    );
    await pg.exec('set role authenticated');
    try {
      const rows = await pg.query('select * from realtime.messages');
      expect(rows.rows).toHaveLength(1);
    } finally {
      await pg.exec('reset role');
    }
    await pg.query("select set_config('realtime.topic',$1,false)", [
      `session:${crypto.randomUUID()}`,
    ]);
    await pg.exec('set role authenticated');
    try {
      const rows = await pg.query('select * from realtime.messages');
      expect(rows.rows).toHaveLength(0);
    } finally {
      await pg.exec('reset role');
    }
  });
  it('rate limits atomically and resets the window', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await pg.query<{ ok: boolean }>('select public.consume_rate_limit($1,3,60) as ok', [
        'attempts',
      ]);
      expect(r.rows[0].ok).toBe(true);
    }
    const blocked = await pg.query<{ ok: boolean }>(
      "select public.consume_rate_limit('attempts',3,60) as ok",
    );
    expect(blocked.rows[0].ok).toBe(false);
    await pg.query(
      "update public.rate_limits set window_start=now()-interval '61 seconds' where key='attempts'",
    );
    const reset = await pg.query<{ ok: boolean }>(
      "select public.consume_rate_limit('attempts',3,60) as ok",
    );
    expect(reset.rows[0].ok).toBe(true);
  });
  it('serializes session launch, requires separate intent, and handles repeated launch IDs', async () => {
    const separateGame = crypto.randomUUID();
    await pg.query('insert into public.games(id,owner_id,board,pin_hash) values ($1,$2,$3,$4)', [
      separateGame,
      HOST,
      JSON.stringify(starterBoard()),
      'test-hash',
    ]);
    const one = createSession(starterBoard(), separateGame, HOST, '888881', Date.now());
    const two = createSession(starterBoard(), separateGame, HOST, '888882', Date.now());
    const launch = (s: typeof one, separate = false) =>
      pg.query<{ id: string }>('select public.launch_session($1,$2,$3) as id', [
        JSON.stringify(s),
        'test-hash',
        separate,
      ]);
    const first = await launch(one);
    expect(first.rows[0].id).toBe(one.id);
    expect((await launch(one)).rows[0].id).toBe(one.id);
    await expect(launch(two)).rejects.toThrow('unfinished session');
    expect((await launch(two, true)).rows[0].id).toBe(two.id);
  });
  it('does not roll back durable state if Realtime publishing fails', async () => {
    const s = await insertSession('999991');
    await pg.exec(
      `create or replace function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language plpgsql as $$ begin raise exception 'Simulated notification outage'; end; $$;`,
    );
    const next = applyCommand(
      s,
      { type: 'join', name: 'Alex' },
      { userId: PLAYER, now: Date.now(), actionId: crypto.randomUUID(), expectedVersion: 0 },
    );
    const committed = await pg.query<{ ok: boolean }>(
      'select public.commit_session($1,0,$2) as ok',
      [s.id, JSON.stringify(next)],
    );
    expect(committed.rows[0].ok).toBe(true);
    const saved = await pg.query<{ version: number }>(
      'select version from public.sessions where id=$1',
      [s.id],
    );
    expect(saved.rows[0].version).toBe(1);
  });
});
