import { beforeEach, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth }) }));
import { identity } from '@/lib/server/db';
const request = () =>
  new NextRequest('http://localhost/api/sessions', {
    headers: { authorization: 'Bearer synthetic-test-token' },
  });
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
  vi.clearAllMocks();
});
it('treats Auth throttling and outages as temporary connection failures rather than expired sessions', async () => {
  for (const status of [undefined, 0, 429, 500, 503]) {
    auth.getUser.mockResolvedValue({ data: { user: null }, error: { status } });
    await expect(identity(request())).rejects.toMatchObject({
      status: 503,
      message: 'Sign-in service is temporarily unavailable. Please retry.',
    });
  }
});
it('keeps invalid or expired credentials unauthorized', async () => {
  auth.getUser.mockResolvedValue({ data: { user: null }, error: { status: 401 } });
  await expect(identity(request())).rejects.toMatchObject({ status: 401 });
});
it('returns only the verified user identity', async () => {
  const user = { id: crypto.randomUUID(), is_anonymous: true };
  auth.getUser.mockResolvedValue({ data: { user }, error: null });
  expect(await identity(request())).toEqual(user);
});
