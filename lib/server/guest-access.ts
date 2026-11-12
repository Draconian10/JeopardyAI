import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function guestSecret(bytes = 18) {
  return randomBytes(bytes).toString('base64url');
}

export function guestSecretHash(kind: 'recovery' | 'display', sessionId: string, value: string) {
  const secret = process.env.RATE_LIMIT_SECRET;
  if (!secret || secret.length < 32) throw new Error('Rate-limit secret is not configured.');
  return createHmac('sha256', secret).update(`${kind}:${sessionId}:${value}`).digest('hex');
}

export function secretMatches(expectedHash: string, suppliedHash: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{64}$/.test(suppliedHash)) return false;
  return timingSafeEqual(Buffer.from(expectedHash, 'hex'), Buffer.from(suppliedHash, 'hex'));
}
