import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const auth = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth }) }));
import { api } from '@/lib/client';
beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test';
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('aborts a stalled fetch so single-flight synchronization can retry', async () => {
  auth.getSession.mockResolvedValue({ data: { session: { access_token: 'test' } } });
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((_url: string, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    return new Promise<Response>((_, reject) =>
      signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
    );
  });
  vi.stubGlobal('fetch', fetch);
  const pending = api('sessions/test', 'GET', undefined, undefined, 1000);
  const checked = expect(pending).rejects.toMatchObject({
    status: 503,
    message: 'Connection timed out. Reconnecting…',
  });
  await vi.advanceTimersByTimeAsync(1001);
  await checked;
  expect(signal?.aborted).toBe(true);
  fetch.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  expect(await api('sessions/test')).toEqual({ ok: true });
});
it('bounds a stalled Auth refresh and does not send a late ghost request', async () => {
  let resolve!: (value: unknown) => void;
  auth.getSession.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const pending = api('sessions/test', 'GET', undefined, undefined, 1000);
  const checked = expect(pending).rejects.toMatchObject({ status: 503 });
  await vi.advanceTimersByTimeAsync(1001);
  await checked;
  resolve({ data: { session: { access_token: 'test' } } });
  await Promise.resolve();
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
});
