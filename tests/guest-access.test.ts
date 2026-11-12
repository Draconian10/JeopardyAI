import { describe, expect, it, vi } from 'vitest';
import { guestSecret, guestSecretHash, secretMatches } from '@/lib/server/guest-access';

describe('restricted spectator and player recovery credentials', () => {
  it('generates high-entropy, URL-safe secrets instead of small guessable PINs', () => {
    const a = guestSecret(18);
    const b = guestSecret(18);
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(a).not.toBe(b);
    expect(guestSecret(24)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('hashes secrets with server-side HMAC and isolates tokens by session and purpose', () => {
    vi.stubEnv('RATE_LIMIT_SECRET', 'a-long-randomly-generated-32-byte-secret-for-ci');
    try {
      const id = crypto.randomUUID();
      const raw = guestSecret();
      const hash = guestSecretHash('recovery', id, raw);
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
      expect(secretMatches(hash, guestSecretHash('recovery', id, raw))).toBe(true);
      expect(secretMatches(hash, guestSecretHash('display', id, raw))).toBe(false);
      expect(secretMatches(hash, guestSecretHash('recovery', crypto.randomUUID(), raw))).toBe(false);
      expect(secretMatches('invalid', hash)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
