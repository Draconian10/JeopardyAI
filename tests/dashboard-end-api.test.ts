import { beforeEach, describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createSession, GameError } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  db: vi.fn(),
  limit: vi.fn(),
  read: vi.fn(),
  mutate: vi.fn(),
  pin: vi.fn(),
}));
vi.mock('@/lib/server/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/server/db')>();
  return {
    ...original,
    identity: mocks.identity,
    db: mocks.db,
    limit: mocks.limit,
    verifyPin: mocks.pin,
  };
});
vi.mock('@/lib/server/sessions', () => ({
  readSession: mocks.read,
  mutate: mocks.mutate,
  loadSession: vi.fn(),
}));
import { POST } from '@/app/api/[...path]/route';
const HOST = crypto.randomUUID(),
  OTHER = crypto.randomUUID();
const state = createSession(starterBoard(), crypto.randomUUID(), HOST, '000001', Date.now());
function request(body: unknown, op = 'end', origin = 'http://localhost') {
  return POST(
    new NextRequest(`http://localhost/api/sessions/${state.id}/${op}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ path: ['sessions', state.id, op] }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockResolvedValue({ id: HOST, is_anonymous: false });
  mocks.db.mockReturnValue({});
  mocks.limit.mockResolvedValue(undefined);
  mocks.read.mockResolvedValue({ id: state.id, state, pin_hash: 'unused', version: state.version });
  mocks.mutate.mockResolvedValue({ ...state, phase: 'ended' });
});
describe('dashboard end endpoint', () => {
  it('ends only after owner authentication and explicit confirmation without checking the game PIN', async () => {
    const actionId = crypto.randomUUID();
    const response = await request({ actionId, confirmed: true });
    expect(response.status).toBe(200);
    expect(mocks.read).toHaveBeenCalledWith(state.id);
    expect(mocks.mutate).toHaveBeenCalledWith(
      state.id,
      { type: 'end' },
      expect.objectContaining({ userId: HOST, dashboardEnd: true, actionId }),
    );
    expect(mocks.pin).not.toHaveBeenCalled();
  });
  it('requires explicit true confirmation', async () => {
    const response = await request({ actionId: crypto.randomUUID(), confirmed: false });
    expect(response.status).toBe(400);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('rejects nonowners', async () => {
    mocks.identity.mockResolvedValue({ id: OTHER, is_anonymous: false });
    const response = await request({ actionId: crypto.randomUUID(), confirmed: true });
    expect(response.status).toBe(403);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('rejects guest users and unauthenticated requests', async () => {
    mocks.identity.mockResolvedValue({ id: OTHER, is_anonymous: true });
    expect((await request({ actionId: crypto.randomUUID(), confirmed: true })).status).toBe(403);
    mocks.identity.mockRejectedValue(new GameError('Sign in again.', 401));
    expect((await request({ actionId: crypto.randomUUID(), confirmed: true })).status).toBe(401);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('rejects a forged dashboard privilege through the general command route', async () => {
    const response = await request(
      { actionId: crypto.randomUUID(), version: 0, command: { type: 'end' }, dashboardEnd: true },
      'command',
    );
    expect(response.status).toBe(400);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it('rejects cross-origin browser mutations', async () => {
    const response = await request(
      { actionId: crypto.randomUUID(), confirmed: true },
      'end',
      'https://unrelated.example',
    );
    expect(response.status).toBe(403);
    expect(mocks.identity).not.toHaveBeenCalled();
  });
});
