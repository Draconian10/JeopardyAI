/** Opt-in capacity experiment: real API handlers + engine + migrations, emulated Supabase transport. */
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { NextRequest } from 'next/server';
import { createSession, HOST_GRACE } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
import type { Session, SessionView } from '@/lib/game/types';
import type { Command } from '@/lib/game/schema';
const transport = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => transport.client }));
import { GET, POST } from '@/app/api/[...path]/route';

const pg = new PGlite();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const reports: unknown[] = [];
const folder = process.env.STRESS_OUTPUT_DIR ?? 'test-results/stress';
function record(value: unknown) {
  reports.push(value);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    `${folder}/progress.json`,
    JSON.stringify({ completedScenarios: reports.length, scenarios: reports }, null, 2),
  );
}
let host = '',
  controller = '',
  game = '',
  session = '';
let users: string[] = [];
let hosts = new Set<string>();
let notify: ((id?: string) => void) | undefined;
let latency = 0,
  authLatency = 0,
  slots = 64,
  active = 0;
let waiters: (() => void)[] = [];
let metrics = freshMetrics();
function freshMetrics() {
  return {
    presenceWrites: 0,
    draftWrites: 0,
    auth: 0,
    reads: 0,
    rate: 0,
    commitAttempts: 0,
    commits: 0,
    casConflicts: 0,
    notifications: 0,
    sessionBytesRead: 0,
    sessionBytesWritten: 0,
    dbPeak: 0,
    dbQueuedPeak: 0,
  };
}
async function dbCall<T>(query: () => Promise<T>) {
  if (active >= slots)
    await new Promise<void>((resolve) => {
      waiters.push(resolve);
      metrics.dbQueuedPeak = Math.max(metrics.dbQueuedPeak, waiters.length);
    });
  else active++;
  metrics.dbPeak = Math.max(metrics.dbPeak, active);
  try {
    if (latency) await sleep(latency);
    return await query();
  } finally {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }
}
function client() {
  return {
    auth: {
      getUser: async (token: string) => {
        metrics.auth++;
        if (authLatency) await sleep(authLatency);
        return users.includes(token)
          ? { data: { user: { id: token, is_anonymous: !hosts.has(token) } }, error: null }
          : { data: { user: null }, error: { message: 'Unknown test identity' } };
      },
    },
    from: (table: string) => {
      if (table !== 'sessions') throw new Error(`Unexpected table ${table}`);
      const filters: Record<string, unknown> = {};
      const builder = {
        select: (_fields: string) => builder,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return builder;
        },
        single: async () =>
          dbCall(async () => {
            metrics.reads++;
            const rows = await pg.query<{
              id: string;
              state: Session;
              pin_hash: string;
              version: number;
            }>('select id,state,pin_hash,version from public.sessions where id=$1', [filters.id]);
            const row = rows.rows[0];
            if (row) metrics.sessionBytesRead += Buffer.byteLength(JSON.stringify(row.state));
            return { data: row ?? null, error: row ? null : { message: 'Missing' } };
          }),
        maybeSingle: async () =>
          dbCall(async () => {
            metrics.reads++;
            const rows = await pg.query<{ id: string }>(
              'select id from public.sessions where join_code=$1 and active=$2',
              [filters.join_code, filters.active],
            );
            return { data: rows.rows[0] ?? null, error: null };
          }),
      };
      return builder;
    },
    rpc: async (name: string, args: Record<string, unknown>) =>
      dbCall(async () => {
        if (name === 'consume_rate_limit') {
          metrics.rate++;
          const r = await pg.query<{ ok: boolean }>(
            'select public.consume_rate_limit($1,$2,$3) as ok',
            [args.p_key, args.p_limit, args.p_seconds],
          );
          return { data: r.rows[0].ok, error: null };
        }
        if (name === 'read_session_runtime') {
          metrics.reads++;
          const r = await pg.query<{ r: { state: Session } }>(
            'select public.read_session_runtime($1) r',
            [args.p_id],
          );
          const row = r.rows[0].r;
          if (row) metrics.sessionBytesRead += Buffer.byteLength(JSON.stringify(row.state));
          return { data: row, error: null };
        }
        if (name === 'touch_session_presence') {
          const r = await pg.query<{ r: Record<string, unknown> }>(
            'select public.touch_session_presence($1,$2,$3) r',
            [args.p_id, args.p_user, args.p_controller],
          );
          if (!r.rows[0].r.error) metrics.presenceWrites++;
          return { data: r.rows[0].r, error: null };
        }
        if (name === 'save_final_draft') {
          const r = await pg.query<{ r: Record<string, unknown> }>(
            'select public.save_final_draft($1,$2,$3,$4,$5) r',
            [args.p_id, args.p_user, args.p_text, args.p_revision, args.p_action],
          );
          if (!r.rows[0].r.error) metrics.draftWrites++;
          if (r.rows[0].r.statusChanged) {
            metrics.notifications++;
            queueMicrotask(() => notify?.(String(args.p_id)));
          }
          return { data: r.rows[0].r, error: null };
        }
        if (!['commit_session', 'claim_session_buzz'].includes(name))
          throw new Error(`Unexpected RPC ${name}`);
        metrics.commitAttempts++;
        const json = JSON.stringify(args.p_state);
        const r =
          name === 'claim_session_buzz'
            ? await pg.query<{ ok: boolean }>(
                'select public.claim_session_buzz($1,$2,$3,$4,$5) ok',
                [args.p_id, args.p_expected, args.p_window, args.p_user, json],
              )
            : await pg.query<{ ok: boolean }>('select public.commit_session($1,$2,$3) ok', [
                args.p_id,
                args.p_expected,
                json,
              ]);
        if (r.rows[0].ok) {
          metrics.commits++;
          metrics.sessionBytesWritten += Buffer.byteLength(json);
          metrics.notifications++;
          // This models delivery to subscriber callbacks, not the actual Supabase WebSocket service.
          queueMicrotask(() => notify?.(String(args.p_id)));
        } else metrics.casConflicts++;
        return { data: r.rows[0].ok, error: null };
      }),
  };
}
beforeAll(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stress.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'local-stress-placeholder';
  process.env.RATE_LIMIT_SECRET = 'local-stress-placeholder-not-a-production-secret';
  await pg.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;
    create schema realtime; create table realtime.messages(id bigserial, extension text, topic text, payload jsonb);
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated; grant select on realtime.messages to authenticated;
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic',true) $$;
    create function realtime.send(payload jsonb,event text,topic text,private boolean) returns void language sql as $$ insert into realtime.messages(extension,topic,payload) values('broadcast',topic,payload) $$;
  `);
  for (const f of [
    '001_initial.sql',
    '002_question_json.sql',
    '003_saved_tiebreakers.sql',
    '004_scalable_runtime.sql',
  ])
    await pg.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'));
  transport.client = client();
  mkdirSync(folder, { recursive: true });
});
afterAll(async () => {
  writeFileSync(
    `${folder}/results.json`,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        runtime: process.version,
        scope:
          'Actual Next route handlers, identity/rate-limit code, engine, persistence retry loops and all SQL migrations. Auth identity verification and Supabase transport/Realtime delivery are emulated; PostgreSQL is local PGlite. Artificial latency/concurrency are experiment inputs, not measured production limits.',
        scenarios: reports,
      },
      null,
      2,
    ),
  );
  await pg.close();
});
async function seed(count: number, phase: 'lobby' | 'board' | 'finalAnswer' = 'board') {
  notify = undefined;
  latency = 0;
  authLatency = 0;
  slots = 64;
  expect(active).toBe(0);
  expect(waiters).toHaveLength(0);
  await pg.exec(
    'truncate public.sessions,public.session_members,public.games,public.rate_limits,auth.users,realtime.messages cascade',
  );
  host = crypto.randomUUID();
  controller = crypto.randomUUID();
  game = crypto.randomUUID();
  users = [host, ...Array.from({ length: count }, () => crypto.randomUUID())];
  hosts = new Set([host]);
  for (const id of users) await pg.query('insert into auth.users(id) values($1)', [id]);
  const s = createSession(starterBoard(), game, host, '123456', Date.now(), controller);
  s.phase = phase;
  s.locked = phase !== 'lobby';
  if (phase !== 'lobby')
    s.players = users.slice(1).map((id, i) => ({
      id,
      name: `Player ${i + 1}`,
      score: 1000,
      lastSeen: Date.now(),
      removed: false,
    }));
  if (phase === 'finalAnswer') {
    s.deadline = Date.now() + 30000;
    s.final = Object.fromEntries(
      s.players.map((p) => [p.id, { score: p.score, wager: 100, text: '' }]),
    );
  }
  session = s.id;
  await pg.query('insert into public.games(id,owner_id,board,pin_hash) values($1,$2,$3,$4)', [
    game,
    host,
    JSON.stringify(s.board),
    'stress',
  ]);
  await pg.query(
    'insert into public.sessions(id,game_id,host_id,join_code,state,pin_hash) values($1,$2,$3,$4,$5,$6)',
    [session, game, host, s.joinCode, JSON.stringify(s), 'stress'],
  );
  metrics = freshMetrics();
  return s;
}
async function route(
  user: string,
  command?: Command,
  version = 0,
  join = false,
  audience = false,
  room?: { id: string; host: string; controller: string },
) {
  const targetSession = room?.id ?? session;
  const targetHost = room?.host ?? host;
  const targetController = room?.controller ?? controller;
  const path = join
    ? ['join']
    : command
      ? ['sessions', targetSession, 'command']
      : ['sessions', targetSession];
  const req = new NextRequest(
    `http://stress.local/api/${path.join('/')}${audience ? '?view=audience' : ''}`,
    {
      method: command || join ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${user}`,
        'x-forwarded-for': '203.0.113.15',
        ...(user === targetHost ? { 'x-controller': targetController } : {}),
        'content-type': 'application/json',
      },
      ...(command || join
        ? {
            body: JSON.stringify(
              join
                ? { code: '123456', name: `Player ${users.indexOf(user)}` }
                : {
                    command,
                    actionId: crypto.randomUUID(),
                    version,
                    controller: user === targetHost ? targetController : undefined,
                  },
            ),
          }
        : {}),
    },
  );
  const start = performance.now();
  const r = await (command || join ? POST : GET)(req, { params: Promise.resolve({ path }) });
  return {
    status: r.status,
    body: (await r.json()) as SessionView & { error?: string },
    ms: performance.now() - start,
  };
}
async function state() {
  return (
    await pg.query<{ r: { state: Session } }>('select public.read_session_runtime($1) r', [session])
  ).rows[0].r.state;
}

function percentiles(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  return {
    p50: Math.round(v[Math.max(0, Math.ceil(v.length * 0.5) - 1)] ?? 0),
    p95: Math.round(v[Math.max(0, Math.ceil(v.length * 0.95) - 1)] ?? 0),
    max: Math.round(v.at(-1) ?? 0),
  };
}
function histogram(values: (number | string)[]) {
  return values.reduce<Record<string, number>>((a, v) => {
    a[String(v)] = (a[String(v)] ?? 0) + 1;
    return a;
  }, {});
}

it('15 concurrent joins and shared-Wi-Fi retry rate limits', async () => {
  await seed(15, 'lobby');
  latency = 10;
  const first = await Promise.all(users.slice(1).map((u) => route(u, undefined, 0, true)));
  expect(first.filter((r) => r.status === 200)).toHaveLength(15);
  const retry = await Promise.all(users.slice(1).map((u) => route(u, undefined, 0, true)));
  expect(retry.filter((r) => r.status === 200)).toHaveLength(15);
  record({
    name: '15 joins then 15 repeated Join-button requests within one minute, same public IP',
    first: histogram(first.map((r) => r.status)),
    retry: histogram(retry.map((r) => r.status)),
    latencyMs: percentiles(first.map((r) => r.ms)),
    database: { ...metrics },
  });
});
it('one winner from 15 simultaneous buzzes across 20 clues', async () => {
  await seed(15);
  latency = 5;
  const rounds = [];
  for (let i = 0; i < 20; i++) {
    let s = await state();
    const q = s.board.questions.filter((q) => !q.dailyDouble)[i];
    const selected = await route(host, { type: 'select', questionId: q.id }, s.actionVersion);
    expect(selected.status).toBe(200);
    const buzzes = await Promise.all(
      users.slice(1).map((u) => route(u, { type: 'buzz', windowId: selected.body.windowId! })),
    );
    expect(buzzes.filter((r) => r.status === 200)).toHaveLength(1);
    expect(buzzes.filter((r) => r.status === 409)).toHaveLength(14);
    s = await state();
    expect(s.respondent).toBeTruthy();
    const judged = await route(host, { type: 'judge', correct: true }, s.actionVersion);
    expect(judged.status).toBe(200);
    const next = await route(host, { type: 'next' }, judged.body.actionVersion);
    expect(next.status).toBe(200);
    rounds.push({
      statuses: histogram(buzzes.map((r) => r.status)),
      winnerMs: buzzes.find((r) => r.status === 200)!.ms,
    });
  }
  const saved = await state();
  expect(saved.events).toHaveLength(20);
  expect(saved.players.reduce((sum, p) => sum + p.score, 0)).toBe(
    15000 + saved.events.reduce((sum, e) => sum + e.delta, 0),
  );
  record({
    name: '20 rounds × 15 simultaneous buzzes',
    rounds: rounds.length,
    successfulWinners: 20,
    expectedLosingBuzzes: 280,
    duplicateScoreEvents: 0,
    winnerLatencyMs: percentiles(rounds.map((r) => r.winnerMs)),
    database: { ...metrics },
  });
});

async function traffic(
  name: string,
  count: number,
  final: boolean,
  delay: number,
  capacity: number,
  coalesce = true,
) {
  const seeded = await seed(count, final ? 'finalAnswer' : 'board');
  latency = delay;
  authLatency = delay / 2;
  slots = capacity;
  const seconds = Number(process.env.STRESS_SECONDS ?? 20);
  if (!Number.isFinite(seconds) || seconds < 10 || seconds > 60)
    throw new Error('STRESS_SECONDS must be between 10 and 60.');
  const duration = seconds * 1000;
  const clients = [...users, host]; // host console + players + one audience display
  let running = true,
    broadcasts = 0,
    requests = 0,
    peakRequests = 0,
    inFlight = 0;
  const outstanding = new Set<Promise<void>>();
  const samples: { kind: string; ms: number; status: number; error?: string }[] = [];
  const snapshots = new Map<string, SessionView>();
  const answerBusy = new Set<string>();
  const readBusy = new Set<number>(),
    readAgain = new Set<number>();
  const launch = (
    user: string,
    kind: string,
    command?: Command,
    audience = false,
    onDone?: () => void,
  ) => {
    requests++;
    inFlight++;
    peakRequests = Math.max(peakRequests, inFlight);
    const p = route(user, command, 0, false, audience)
      .then((r) => {
        samples.push({ kind, ms: r.ms, status: r.status, error: r.body.error });
        if (
          r.body.phase &&
          (!snapshots.has(user) || r.body.version >= snapshots.get(user)!.version)
        )
          snapshots.set(user, r.body);
      })
      .catch((e) => {
        samples.push({ kind, ms: 0, status: 0, error: String(e) });
      })
      .finally(() => {
        inFlight--;
        outstanding.delete(p);
        onDone?.();
      });
    outstanding.add(p);
  };
  const refresh = (index: number, kind: string) => {
    if (!running) return;
    if (coalesce && readBusy.has(index)) {
      readAgain.add(index);
      return;
    }
    readBusy.add(index);
    launch(clients[index], kind, undefined, index === clients.length - 1, () => {
      readBusy.delete(index);
      if (coalesce && readAgain.delete(index) && running) refresh(index, 'coalesced');
    });
  };
  notify = () => {
    broadcasts++;
    if (running) clients.forEach((_, i) => refresh(i, 'broadcast'));
  };
  const timers: ReturnType<typeof setInterval>[] = [];
  clients.forEach((_, i) => {
    refresh(i, 'initial');
    timers.push(setInterval(() => refresh(i, 'poll'), 10000));
  });
  users.forEach((u) => {
    launch(u, 'heartbeat', { type: 'heartbeat' });
    timers.push(
      setInterval(() => {
        if (running) launch(u, 'heartbeat', { type: 'heartbeat' });
      }, 5000),
    );
  });
  if (final)
    users.slice(1).forEach((u, i) => {
      let edits = 0;
      timers.push(
        setInterval(() => {
          const snapshot = snapshots.get(u);
          if (
            running &&
            Date.now() < seeded.deadline! &&
            snapshot?.phase === 'finalAnswer' &&
            !snapshot.paused &&
            !answerBusy.has(u)
          ) {
            answerBusy.add(u);
            launch(
              u,
              'answer',
              { type: 'answer', text: `Response ${i} edit ${++edits}` },
              false,
              () => answerBusy.delete(u),
            );
          }
        }, 500),
      );
    });
  if (final && seeded.deadline)
    timers.push(
      setTimeout(
        () => clients.forEach((_, i) => refresh(i, 'deadline')),
        Math.max(0, seeded.deadline - Date.now()),
      ),
    );
  await sleep(duration);
  running = false;
  notify = undefined;
  timers.forEach(clearInterval);
  const drainStart = performance.now();
  while (outstanding.size) await Promise.all([...outstanding]);
  const drainSeconds = Math.round((performance.now() - drainStart) / 100) / 10;
  if (final && Date.now() >= seeded.deadline!) await route(host);
  const saved = await state();
  const hb = samples.filter((s) => s.kind === 'heartbeat');
  const result = {
    name,
    players: count,
    subscribers: clients.length,
    durationSeconds: duration / 1000,
    inputs: {
      perDatabaseOperationDelayMs: delay,
      authDelayMs: authLatency,
      emulatedDatabaseOperationSlots: capacity,
      coalescedReads: coalesce,
    },
    requests,
    peakInFlightRequests: peakRequests,
    statuses: histogram(samples.map((s) => s.status)),
    errors: histogram(
      samples.filter((s) => s.status !== 200).map((s) => `${s.status}: ${s.error}`),
    ),
    requestLatencyMs: percentiles(samples.map((s) => s.ms)),
    overFunctionBudget30s: samples.filter((s) => s.ms > 30000).length,
    heartbeatLatencyMs: percentiles(hb.map((s) => s.ms)),
    heartbeats: histogram(hb.map((s) => s.status)),
    broadcastCallbacks: broadcasts,
    deliveredEvents: broadcasts * clients.length,
    drainSeconds,
    observedSavedPhase: saved.phase,
    hostPaused: saved.paused,
    hostPauseReason: saved.pauseReason,
    receivedFinalAnswers: Object.values(saved.final).filter((e) => e.text).length,
    database: { ...metrics },
  };
  record(result);
  console.log(JSON.stringify(result));
  expect(saved.players).toHaveLength(count);
  expect(saved.paused).toBe(false);
  const unexpected = samples.filter(
    (s) =>
      s.status !== 200 &&
      !(s.kind === 'answer' && s.status === 409 && s.error === 'Responses are locked.'),
  );
  expect(unexpected).toEqual([]);
  if (final) expect(Object.values(saved.final).filter((e) => e.text)).toHaveLength(count);
}
it('4 players idle, 10ms operations / 64 slots', () =>
  traffic('4-player baseline idle', 4, false, 10, 64));
it('15 players idle, 10ms operations / 64 slots', () =>
  traffic('15-player idle', 15, false, 10, 64));
it('15 players Final answer autosave, 10ms operations / 64 slots', () =>
  traffic('15-player Final typing', 15, true, 10, 64));
it('15 players Final answer autosave, 100ms operations / 16 slots', () =>
  traffic('15-player Final typing, slower constrained transport', 15, true, 100, 16));
it('15 players Final answer autosave, 150ms operations / 16 slots', () =>
  traffic('15-player Final typing, degraded transport', 15, true, 150, 16));
it('15 players Final answer autosave, same slow transport, uncoalesced snapshot experiment', () =>
  traffic('15-player Final typing, experimental uncoalesced reads', 15, true, 100, 16, false));
it('a host heartbeat arriving after the 30-second lease boundary leaves a durable pause', async () => {
  const s = await seed(15);
  s.hostSeen = Date.now() - HOST_GRACE - 1000;
  await pg.query('update public.sessions set state=$2 where id=$1', [session, JSON.stringify(s)]);
  const r = await route(host, { type: 'heartbeat' });
  expect(r.status).toBe(200);
  expect(r.body).toHaveProperty('needsRefresh', true);
  const snapshot = await route(host);
  expect(snapshot.body.paused).toBe(true);
  expect(snapshot.body.pauseReason).toBe('Host disconnected');
  record({
    name: '31-second host heartbeat gap',
    status: r.status,
    paused: snapshot.body.paused,
    reason: snapshot.body.pauseReason,
    note: 'A deterministic boundary test, not proof that production latency reached 31 seconds.',
  });
});

it('three independent 15-player rooms stay healthy through a full Final and one-minute presence run', async () => {
  const first = await seed(15, 'finalAnswer');
  type Room = { id: string; host: string; controller: string; players: string[]; deadline: number };
  const rooms: Room[] = [
    { id: first.id, host, controller, players: users.slice(1), deadline: first.deadline! },
  ];
  for (let i = 1; i < 3; i++) {
    const owner = crypto.randomUUID(),
      seats = Array.from({ length: 15 }, () => crypto.randomUUID()),
      control = crypto.randomUUID(),
      gid = crypto.randomUUID();
    for (const id of [owner, ...seats]) await pg.query('insert into auth.users values($1)', [id]);
    users.push(owner, ...seats);
    hosts.add(owner);
    const s = createSession(starterBoard(), gid, owner, String(123456 + i), Date.now(), control);
    s.phase = 'finalAnswer';
    s.deadline = Date.now() + 30000;
    s.players = seats.map((id, n) => ({
      id,
      name: `Room ${i} player ${n}`,
      score: 1000,
      lastSeen: Date.now(),
      removed: false,
    }));
    s.final = Object.fromEntries(seats.map((id) => [id, { score: 1000, wager: 100, text: '' }]));
    await pg.query('insert into public.games(id,owner_id,board,pin_hash) values($1,$2,$3,$4)', [
      gid,
      owner,
      JSON.stringify(s.board),
      'stress',
    ]);
    await pg.query(
      'insert into public.sessions(id,game_id,host_id,join_code,state,pin_hash) values($1,$2,$3,$4,$5,$6)',
      [s.id, gid, owner, s.joinCode, JSON.stringify(s), 'stress'],
    );
    rooms.push({
      id: s.id,
      host: owner,
      controller: control,
      players: seats,
      deadline: s.deadline,
    });
  }
  latency = 100;
  authLatency = 50;
  slots = 16;
  let running = true,
    peak = 0,
    activeRequests = 0,
    broadcasts = 0;
  const outstanding = new Set<Promise<void>>(),
    readBusy = new Set<string>(),
    readAgain = new Set<string>(),
    answerBusy = new Set<string>();
  const snapshots = new Map<string, SessionView>();
  const samples: { kind: string; status: number; ms: number; error?: string }[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const launch = (
    room: Room,
    user: string,
    kind: string,
    command?: Command,
    audience = false,
    done?: () => void,
  ) => {
    activeRequests++;
    peak = Math.max(peak, activeRequests);
    const task = route(user, command, 0, false, audience, room)
      .then((r) => {
        samples.push({ kind, status: r.status, ms: r.ms, error: r.body.error });
        const key = room.id + user;
        if (r.body.phase && (!snapshots.has(key) || r.body.version >= snapshots.get(key)!.version))
          snapshots.set(key, r.body);
      })
      .finally(() => {
        activeRequests--;
        outstanding.delete(task);
        done?.();
      });
    outstanding.add(task);
  };
  const refresh = (room: Room, user: string, audience = false) => {
    if (!running) return;
    const key = room.id + user + (audience ? 'audience' : '');
    if (readBusy.has(key)) {
      readAgain.add(key);
      return;
    }
    readBusy.add(key);
    launch(room, user, 'snapshot', undefined, audience, () => {
      readBusy.delete(key);
      if (readAgain.delete(key) && running) refresh(room, user, audience);
    });
  };
  notify = (id) => {
    if (!running) return;
    broadcasts++;
    const room = rooms.find((r) => r.id === id);
    if (!room) return;
    [room.host, ...room.players].forEach((user) => refresh(room, user));
    refresh(room, room.host, true);
  };
  for (const room of rooms) {
    for (const user of [room.host, ...room.players]) {
      refresh(room, user);
      launch(room, user, 'heartbeat', { type: 'heartbeat' });
      timers.push(
        setInterval(() => {
          if (running) launch(room, user, 'heartbeat', { type: 'heartbeat' });
        }, 5000),
      );
      timers.push(setInterval(() => refresh(room, user), 10000));
    }
    refresh(room, room.host, true);
    timers.push(setInterval(() => refresh(room, room.host, true), 10000));
    timers.push(
      setTimeout(
        () => {
          [room.host, ...room.players].forEach((user) => refresh(room, user));
          refresh(room, room.host, true);
        },
        Math.max(0, room.deadline - Date.now()),
      ),
    );
    for (const user of room.players) {
      let edits = 0;
      const key = room.id + user;
      timers.push(
        setInterval(() => {
          const view = snapshots.get(key);
          if (
            !running ||
            Date.now() >= room.deadline ||
            view?.phase !== 'finalAnswer' ||
            view.paused ||
            answerBusy.has(key)
          )
            return;
          answerBusy.add(key);
          launch(
            room,
            user,
            'answer',
            { type: 'answer', text: `Room response ${++edits}` },
            false,
            () => answerBusy.delete(key),
          );
        }, 500),
      );
    }
  }
  await sleep(60000);
  running = false;
  notify = undefined;
  timers.forEach(clearInterval);
  while (outstanding.size) await Promise.all([...outstanding]);
  const states = [];
  for (const room of rooms) {
    await route(room.host, undefined, 0, false, false, room);
    states.push(
      (
        await pg.query<{ r: { state: Session } }>('select public.read_session_runtime($1) r', [
          room.id,
        ])
      ).rows[0].r.state,
    );
  }
  expect(states.every((s) => !s.paused && s.phase === 'finalReveal')).toBe(true);
  expect(states.map((s) => Object.values(s.final).filter((e) => e.text).length)).toEqual([
    15, 15, 15,
  ]);
  const unexpected = samples.filter(
    (s) =>
      s.status !== 200 &&
      !(s.kind === 'answer' && s.status === 409 && s.error === 'Responses are locked.'),
  );
  expect(unexpected).toEqual([]);
  record({
    name: '3 rooms × 15 players, full Final then 60-second presence observation',
    players: 45,
    subscribers: 51,
    durationSeconds: 60,
    inputs: {
      perDatabaseOperationDelayMs: 100,
      authDelayMs: 50,
      emulatedDatabaseOperationSlots: 16,
    },
    requests: samples.length,
    peakInFlightRequests: peak,
    statuses: histogram(samples.map((s) => s.status)),
    unexpectedErrors: unexpected.length,
    heartbeatLatencyMs: percentiles(samples.filter((s) => s.kind === 'heartbeat').map((s) => s.ms)),
    responsesPerRoom: states.map((s) => Object.values(s.final).filter((e) => e.text).length),
    pausedRooms: states.filter((s) => s.paused).length,
    broadcastCallbacks: broadcasts,
    database: { ...metrics },
  });
});
