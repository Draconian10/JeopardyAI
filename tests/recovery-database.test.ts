import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createSession, viewSession } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
import type { Session } from '@/lib/game/types';

const pg = new PGlite();
const HOST = crypto.randomUUID();
const CLAIMANT = crypto.randomUUID();
const GAME = crypto.randomUUID();
const players = Array.from({ length: 15 }, () => crypto.randomUUID());
const oldId = players[0];
const requestId = crypto.randomUUID();
let session: Session;

beforeAll(async () => {
  await pg.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create schema realtime; create table realtime.messages(id bigserial,extension text,topic text,payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated;
    grant select on realtime.messages to authenticated;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    create function realtime.send(payload jsonb,event text,topic text,private boolean)
      returns void language sql as $$ insert into realtime.messages(extension,topic,payload) values('broadcast',topic,payload) $$;`);
  for (const file of [
    '001_initial.sql',
    '002_question_json.sql',
    '003_saved_tiebreakers.sql',
    '004_scalable_runtime.sql',
    '005_player_recovery_display.sql',
  ])
    await pg.exec(readFileSync(`supabase/migrations/${file}`, 'utf8'));
  for (const id of [HOST, CLAIMANT, ...players])
    await pg.query('insert into auth.users values($1)', [id]);

  session = createSession(starterBoard(), GAME, HOST, '719283', Date.now(), crypto.randomUUID());
  session.players = players.map((id, i) => ({
    id,
    name: `Player ${i + 1}`,
    score: 1000 + i * 100,
    lastSeen: Date.now(),
    removed: false,
  }));
  session.phase = 'finalAnswer';
  session.deadline = Date.now() + 120_000;
  session.final = Object.fromEntries(
    players.map((id) => [
      id,
      {
        score: 1000,
        wager: 200,
        text: '',
      },
    ]),
  );
  session.final[oldId].text = 'Old snapshot';
  session.respondent = oldId;
  session.nextSelectorId = oldId;
  session.attempted = [oldId];
  session.daily = { playerId: oldId, amount: 200, submitted: true };
  session.events = [
    {
      id: crypto.randomUUID(),
      questionId: session.board.questions[0].id,
      playerId: oldId,
      delta: 200,
      reason: 'correct',
      at: Date.now(),
    },
  ];
  session.history = [
    {
      actionId: crypto.randomUUID(),
      userId: oldId,
      type: 'buzz',
      at: Date.now(),
      phase: 'question',
    },
  ];
  session.undoStack = [
    {
      questionId: session.board.questions[0].id,
      phase: 'answering',
      respondent: oldId,
      attempted: [oldId],
      remaining: 1000,
      used: [],
      eventsLength: 1,
      nextSelectorId: oldId,
      scores: { [oldId]: 1000 },
    },
  ];
  await pg.query('insert into public.games(id,owner_id,board,pin_hash) values($1,$2,$3,$4)', [
    GAME,
    HOST,
    JSON.stringify(starterBoard()),
    'pin',
  ]);
  await pg.query(
    'insert into public.sessions(id,game_id,host_id,join_code,state,pin_hash) values($1,$2,$3,$4,$5,$6)',
    [session.id, GAME, HOST, session.joinCode, JSON.stringify(session), 'pin'],
  );
  await pg.query('insert into public.session_members(session_id,user_id) values($1,$2)', [
    session.id,
    HOST,
  ]);
  for (const id of players)
    await pg.query('insert into public.session_members(session_id,user_id) values($1,$2)', [
      session.id,
      id,
    ]);
  await pg.query(
    'insert into public.session_presence(session_id,user_id,last_seen_ms) values($1,$2,$3)',
    [session.id, HOST, Date.now()],
  );
  await pg.query(
    'insert into public.session_presence(session_id,user_id,last_seen_ms) values($1,$2,$3)',
    [session.id, oldId, Date.now()],
  );
  await pg.query(
    'insert into public.session_final_drafts(session_id,user_id,text,revision,submitted_at_ms,action_id) values($1,$2,$3,$4,$5,$6)',
    [session.id, oldId, 'Recovered final response', 3, Date.now(), crypto.randomUUID()],
  );
  await pg.query(
    'insert into public.session_final_receipts(session_id,user_id,action_id,revision,submitted_at_ms) values($1,$2,$3,$4,$5)',
    [session.id, oldId, crypto.randomUUID(), 3, Date.now()],
  );
  await pg.query(
    "insert into public.session_player_recovery_codes(session_id,player_id,code_hash,expires_at) values($1,$2,$3,now()+interval '12 hours')",
    [session.id, oldId, 'a'.repeat(64)],
  );
  await pg.query(
    "insert into public.session_player_recovery_requests(id,session_id,player_id,claimant_id,expires_at) values($1,$2,$3,$4,now()+interval '10 minutes')",
    [requestId, session.id, oldId, CLAIMANT],
  );
}, 30000);

afterAll(async () => pg.close());

describe('atomic player-seat recovery across fifteen players', () => {
  it('denies approval from an unrelated host identity', async () => {
    const result = await pg.query<{ r: { status: number; error: string } }>(
      'select public.approve_player_recovery($1,$2,$3) r',
      [session.id, CLAIMANT, requestId],
    );
    expect(result.rows[0].r.status).toBe(403);
  });

  it('preserves every player, Final draft, history and membership in a single transfer', async () => {
    const result = await pg.query<{ r: { approved: boolean } }>(
      'select public.approve_player_recovery($1,$2,$3) r',
      [session.id, HOST, requestId],
    );
    expect(result.rows[0].r.approved).toBe(true);
    const res = await pg.query<{ r: { state: Session } }>(
      'select public.read_session_runtime($1) r',
      [session.id],
    );
    const s = res.rows[0].r.state;
    expect(s.players).toHaveLength(15);
    expect(s.players[0].id).toBe(CLAIMANT);
    expect(s.players[0].score).toBe(1000);
    expect(s.players.every((p) => p.id !== oldId)).toBe(true);
    expect(s.final[oldId]).toBeUndefined();
    expect(s.final[CLAIMANT].text).toBe('Recovered final response');
    expect(s.respondent).toBe(CLAIMANT);
    expect(s.nextSelectorId).toBe(CLAIMANT);
    expect(s.attempted).toContain(CLAIMANT);
    expect(s.events[0].playerId).toBe(CLAIMANT);
    expect(s.history[0].userId).toBe(CLAIMANT);
    expect(s.daily?.playerId).toBe(CLAIMANT);
    expect(s.undoStack?.[0].scores[CLAIMANT]).toBe(1000);
    const member = await pg.query<{ user_id: string }>(
      'select user_id from public.session_members where session_id=$1 order by user_id',
      [session.id],
    );
    expect(member.rows).toHaveLength(16);
    expect(member.rows.some((m) => m.user_id === oldId)).toBe(false);
    expect(member.rows.some((m) => m.user_id === CLAIMANT)).toBe(true);
    const drafts = await pg.query(
      'select user_id from public.session_final_drafts where session_id=$1',
      [session.id],
    );
    expect(drafts.rows).toEqual([{ user_id: CLAIMANT }]);
    const receipts = await pg.query(
      'select user_id from public.session_final_receipts where session_id=$1',
      [session.id],
    );
    expect(receipts.rows).toEqual([{ user_id: CLAIMANT }]);
    const codes = await pg.query(
      'select * from public.session_player_recovery_codes where session_id=$1',
      [session.id],
    );
    expect(codes.rows).toHaveLength(0);
    const v = viewSession(s, CLAIMANT, Date.now());
    expect(v.finalEntries[CLAIMANT].text).toBe('Recovered final response');
    const second = await pg.query<{ r: { status: number } }>(
      'select public.approve_player_recovery($1,$2,$3) r',
      [session.id, HOST, requestId],
    );
    expect(second.rows[0].r.status).toBe(409);
  });

  it('rotating a player code invalidates claims made using its predecessor', async () => {
    const candidate = players[1];
    const another = crypto.randomUUID();
    await pg.query('insert into auth.users values($1)', [another]);
    const claim = crypto.randomUUID();
    await pg.query(
      "insert into public.session_player_recovery_requests(id,session_id,player_id,claimant_id,expires_at) values($1,$2,$3,$4,now()+interval '10 minutes')",
      [claim, session.id, candidate, another],
    );
    const result = await pg.query<{ ok: boolean }>(
      "select public.rotate_player_recovery_code($1,$2,$3,now()+interval '12 hours') ok",
      [session.id, candidate, 'b'.repeat(64)],
    );
    expect(result.rows[0].ok).toBe(true);
    const requests = await pg.query<{ status: string }>(
      'select status from public.session_player_recovery_requests where id=$1',
      [claim],
    );
    expect(requests.rows[0].status).toBe('rejected');
    const token = await pg.query<{ code_hash: string }>(
      'select code_hash from public.session_player_recovery_codes where session_id=$1 and player_id=$2',
      [session.id, candidate],
    );
    expect(token.rows[0].code_hash).toBe('b'.repeat(64));
    const res = await pg.query<{ r: { state: Session } }>(
      'select public.read_session_runtime($1) r',
      [session.id],
    );
    expect(res.rows[0].r.state.players).toHaveLength(15);
  });

  it('prevents old recovery codes from opening requests after atomic rotation', async () => {
    const claimant = crypto.randomUUID();
    const oldPlayer = players[2];
    await pg.query('insert into auth.users values($1)', [claimant]);
    const firstHash = 'c'.repeat(64);
    const rotatedHash = 'd'.repeat(64);
    const setup = await pg.query<{ ok: boolean }>(
      "select public.rotate_player_recovery_code($1,$2,$3,now()+interval '12 hours') ok",
      [session.id, oldPlayer, firstHash],
    );
    expect(setup.rows[0].ok).toBe(true);
    const requested = await pg.query<{ r: { requestId: string } }>(
      'select public.request_player_recovery($1,$2,$3) r',
      [session.id, claimant, firstHash],
    );
    expect(requested.rows[0].r.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const rotated = await pg.query<{ ok: boolean }>(
      "select public.rotate_player_recovery_code($1,$2,$3,now()+interval '12 hours') ok",
      [session.id, oldPlayer, rotatedHash],
    );
    expect(rotated.rows[0].ok).toBe(true);
    const invalidated = await pg.query<{ status: string }>(
      'select status from public.session_player_recovery_requests where id=$1',
      [requested.rows[0].r.requestId],
    );
    expect(invalidated.rows[0].status).toBe('rejected');
    const obsolete = await pg.query<{ r: { status?: number } }>(
      'select public.request_player_recovery($1,$2,$3) r',
      [session.id, claimant, firstHash],
    );
    expect(obsolete.rows[0].r.status).toBe(404);
    const fresh = await pg.query<{ r: { requestId: string } }>(
      'select public.request_player_recovery($1,$2,$3) r',
      [session.id, claimant, rotatedHash],
    );
    expect(fresh.rows[0].r.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const original = await pg.query<{ r: { state: Session } }>(
      'select public.read_session_runtime($1) r', [session.id],
    );
    expect(original.rows[0].r.state.players).toHaveLength(15);
  });

  it('keeps new private tables inaccessible to ordinary authenticated clients', async () => {
    await pg.exec('set role authenticated');
    try {
      for (const table of [
        'session_player_recovery_codes',
        'session_player_recovery_requests',
        'session_display_links',
      ])
        await expect(pg.query(`select * from public.${table}`)).rejects.toThrow();
      await expect(
        pg.query(`select public.approve_player_recovery('${session.id}','${HOST}','${requestId}')`),
      ).rejects.toThrow();
    } finally {
      await pg.exec('reset role');
    }
  });
});
