import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createSession, GameError } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  db: vi.fn(),
  limit: vi.fn(),
  read: vi.fn(),
  pin: vi.fn(),
}));
vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  identity: mocks.identity,
  db: mocks.db,
  limit: mocks.limit,
  verifyPin: mocks.pin,
}));
vi.mock('@/lib/server/sessions', () => ({
  readSession: mocks.read,
  loadSession: vi.fn(),
  mutate: vi.fn(),
}));
import { GET, POST } from '@/app/api/[...path]/route';
const HOST = crypto.randomUUID(),
  OTHER = crypto.randomUUID(),
  CONTROL = crypto.randomUUID(),
  GAME = crypto.randomUUID(),
  ID = crypto.randomUUID();
let s = createSession(starterBoard(), GAME, HOST, '001234', Date.now());
let rpc = vi.fn();
let existing: { id: string; state: typeof s } | null = null;
function req(resource: string, id: string, op: string, body?: unknown) {
  return (body ? POST : GET)(
    new NextRequest(
      `http://localhost/api/${resource}/${id}/${op}`,
      body
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : undefined,
    ),
    { params: Promise.resolve({ path: [resource, id, op] }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  existing = null;
  s = createSession(starterBoard(), GAME, HOST, '001234', Date.now());
  s.phase = 'finished';
  s.players = [{ id: OTHER, name: 'Alex', score: 0, lastSeen: Date.now(), removed: false }];
  mocks.identity.mockResolvedValue({ id: HOST, is_anonymous: false });
  mocks.read.mockImplementation(async () => ({ state: s }));
  mocks.pin.mockReturnValue(true);
  rpc = vi.fn().mockResolvedValue({ error: null });
  mocks.db.mockReturnValue({
    from: (table: string) => {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        single: vi.fn(async () => ({
          data: { id: GAME, board: starterBoard(), pin_hash: 'hashed', archived: false },
        })),
        maybeSingle: vi.fn(async () => ({ data: existing })),
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return builder;
    },
    rpc,
  });
});
describe('fresh session launch', () => {
  it('atomically launches an unpaused lobby with the verified host controller', async () => {
    const response = await req('games', GAME, 'start', {
      pin: '123456',
      requestId: ID,
      controller: CONTROL,
    });
    expect(response.status).toBe(201);
    expect(rpc).toHaveBeenCalledWith(
      'launch_session',
      expect.objectContaining({
        p_state: expect.objectContaining({
          id: ID,
          controller: CONTROL,
          paused: false,
          phase: 'lobby',
          hostId: HOST,
        }),
      }),
    );
    expect(JSON.stringify(await response.json())).not.toContain(CONTROL);
  });
  it('returns an existing launch on retry without replacing its controller or creating a second session', async () => {
    s.controller = CONTROL;
    existing = { id: ID, state: s };
    const response = await req('games', GAME, 'start', {
      pin: '123456',
      requestId: ID,
      controller: crypto.randomUUID(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: ID });
    expect(s.controller).toBe(CONTROL);
    expect(rpc).not.toHaveBeenCalled();
  });
  it('never grants control for an incorrect PIN or malformed controller', async () => {
    mocks.pin.mockReturnValue(false);
    expect(
      (await req('games', GAME, 'start', { pin: '000000', requestId: ID, controller: CONTROL }))
        .status,
    ).toBe(403);
    mocks.pin.mockReturnValue(true);
    expect(
      (await req('games', GAME, 'start', { pin: '123456', requestId: ID, controller: 'bad' }))
        .status,
    ).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });
});
describe('results download', () => {
  it('returns a private CSV attachment for the owner without needing control or a PIN', async () => {
    const response = await req('sessions', s.id, 'results');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('content-disposition')).toContain(`jeopardy-results-${s.id}.csv`);
    expect(await response.text()).toContain('Final standing');
    expect(mocks.pin).not.toHaveBeenCalled();
  });
  it('rejects players, nonowners and expired authentication', async () => {
    mocks.identity.mockResolvedValue({ id: OTHER, is_anonymous: true });
    expect((await req('sessions', s.id, 'results')).status).toBe(403);
    mocks.identity.mockResolvedValue({ id: OTHER, is_anonymous: false });
    expect((await req('sessions', s.id, 'results')).status).toBe(403);
    mocks.identity.mockRejectedValue(new GameError('Sign in again.', 401));
    expect((await req('sessions', s.id, 'results')).status).toBe(401);
  });
  it('rejects live sessions and accepts sessions ended early', async () => {
    s.phase = 'board';
    expect((await req('sessions', s.id, 'results')).status).toBe(409);
    s.phase = 'ended';
    expect((await req('sessions', s.id, 'results')).status).toBe(200);
  });
});

describe('dashboard session history titles', () => {
  it('returns frozen session titles rather than renamed board titles without exposing private state', async () => {
    s.title = 'Original round';
    s.board.title = 'Original round';
    const eq = vi.fn();
    mocks.db.mockReturnValue({
      from: (table: string) => {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn((...args: unknown[]) => {
            eq(...args);
            return query;
          }),
          order: vi.fn(async () => ({
            data:
              table === 'games'
                ? [
                    {
                      id: GAME,
                      board: { ...s.board, title: 'Renamed round' },
                      version: 2,
                      updated_at: new Date().toISOString(),
                      archived: false,
                    },
                  ]
                : [
                    {
                      id: s.id,
                      game_id: GAME,
                      join_code: s.joinCode,
                      active: false,
                      state: s,
                      created_at: new Date().toISOString(),
                    },
                  ],
            error: null,
          })),
        };
        return query;
      },
    });
    const response = await GET(new NextRequest('http://localhost/api/games'), {
      params: Promise.resolve({ path: ['games'] }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.games[0].title).toBe('Renamed round');
    expect(body.sessions[0].title).toBe('Original round');
    expect(body.sessions[0]).not.toHaveProperty('state');
    expect(body.sessions[0]).not.toHaveProperty('board');
    expect(eq).toHaveBeenCalledWith('owner_id', HOST);
    expect(eq).toHaveBeenCalledWith('host_id', HOST);
  });
});
