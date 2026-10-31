import { createClient } from '@supabase/supabase-js';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { GameError } from '@/lib/game/engine';
export function db() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new GameError('Configure Supabase environment variables first.', 503);
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}
export async function identity(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token || token.length > 8192) throw new GameError('Please sign in or join again.', 401);
  const { data, error } = await db().auth.getUser(token);
  if (error || !data.user) throw new GameError('Your session expired. Sign in again.', 401);
  return data.user;
}
export function hostOnly(user: { is_anonymous?: boolean }) {
  if (user.is_anonymous) throw new GameError('Sign in with a host account.', 403);
}
export function hashPin(pin: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}
export function verifyPin(pin: string, hash: string) {
  const [salt, digest] = hash.split(':');
  if (!salt || !digest) return false;
  const expected = Buffer.from(digest, 'hex');
  const actual = scryptSync(pin, salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export async function limit(
  req: NextRequest,
  userId: string,
  scope: string,
  count = 30,
  seconds = 60,
) {
  const secret = process.env.RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32)
    throw new GameError('Configure a RATE_LIMIT_SECRET of at least 32 characters.', 503);
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local';
  for (const subject of [userId, ip]) {
    const key = createHmac('sha256', secret).update(`${scope}:${subject}`).digest('hex');
    const { data, error } = await db().rpc('consume_rate_limit', {
      p_key: key,
      p_limit:
        subject === ip && ['commands', 'answers', 'heartbeat', 'tick'].includes(scope)
          ? count * 50
          : count,
      p_seconds: seconds,
    });
    if (error) throw new GameError('Rate limit service unavailable.', 503);
    if (!data) throw new GameError('Too many attempts. Please wait and try again.', 429);
  }
}
