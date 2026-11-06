import { beforeEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { GameError } from '@/lib/game/engine';
const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  limit: vi.fn(),
  heartbeat: vi.fn(),
  saveAnswer: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock('@/lib/server/db', async (original) => ({
  ...(await original<typeof import('@/lib/server/db')>()),
  identity: mocks.identity,
  limit: mocks.limit,
  db: () => ({}),
}));
vi.mock('@/lib/server/sessions', () => ({
  heartbeat: mocks.heartbeat,
  saveAnswer: mocks.saveAnswer,
  mutate: mocks.mutate,
  readSession: vi.fn(),
  loadSession: vi.fn(),
}));
import { POST } from '@/app/api/[...path]/route';
const ID = crypto.randomUUID(),
  USER = crypto.randomUUID(),
  ACTION = crypto.randomUUID();
async function command(value: unknown) {
  return POST(
    new NextRequest(`http://localhost/api/sessions/${ID}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: value, actionId: ACTION, version: 0 }),
    }),
    { params: Promise.resolve({ path: ['sessions', ID, 'command'] }) },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.identity.mockResolvedValue({ id: USER, is_anonymous: true });
  mocks.heartbeat.mockResolvedValue({ kind: 'heartbeat', serverNow: 100, host: false });
  mocks.saveAnswer.mockResolvedValue({
    kind: 'answer',
    text: 'Saved',
    submittedAt: 100,
    serverNow: 100,
    revision: 2,
  });
});
it('returns a narrow heartbeat receipt without loading or committing the aggregate', async () => {
  const response = await command({ type: 'heartbeat' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ kind: 'heartbeat', serverNow: 100, host: false });
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it('returns only the owner response acknowledgement and forwards revision/idempotency metadata', async () => {
  const response = await command({ type: 'answer', text: 'Saved', revision: 2 });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    kind: 'answer',
    text: 'Saved',
    submittedAt: 100,
    serverNow: 100,
    revision: 2,
  });
  expect(mocks.saveAnswer).toHaveBeenCalledWith(
    ID,
    { type: 'answer', text: 'Saved', revision: 2 },
    expect.objectContaining({ userId: USER, actionId: ACTION }),
  );
  expect(mocks.mutate).not.toHaveBeenCalled();
});
it('rejects invalid revisions before any draft RPC and preserves permission failures', async () => {
  for (const revision of [0, -1, 1.5])
    expect((await command({ type: 'answer', text: 'Saved', revision })).status).toBe(400);
  expect(mocks.saveAnswer).not.toHaveBeenCalled();
  mocks.saveAnswer.mockRejectedValue(new GameError('Only a player can submit.', 403));
  expect((await command({ type: 'answer', text: 'Saved', revision: 1 })).status).toBe(403);
});
