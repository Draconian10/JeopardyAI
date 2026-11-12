import { describe, expect, it } from 'vitest';
import {
  hostConfirmationRedirect,
  hostPasswordRecoveryRedirect,
  isHostPlayerConflict,
} from '@/lib/auth-flow';

describe('host email confirmation redirect', () => {
  it('returns to the host page on the current production origin', () => {
    expect(hostConfirmationRedirect('https://jeopardy.example')).toBe(
      'https://jeopardy.example/host?confirmed=1',
    );
  });

  it('prefers an explicitly configured public URL over the current preview deployment', () => {
    expect(
      hostConfirmationRedirect('https://private-preview.vercel.app', 'https://jeopardy.example/'),
    ).toBe('https://jeopardy.example/host?confirmed=1');
  });
});

describe('host password reset redirect', () => {
  it('returns to the public game domain instead of a private preview', () => {
    expect(hostPasswordRecoveryRedirect('https://preview.vercel.app', 'https://game.example')).toBe(
      'https://game.example/host?reset=1',
    );
  });
});

describe('host player identity conflict', () => {
  it('recognizes the exact server guard message', () => {
    expect(
      isHostPlayerConflict(new Error('Use a separate device or browser profile to play.')),
    ).toBe(true);
  });

  it('does not mistake other join failures for an identity conflict', () => {
    expect(isHostPlayerConflict(new Error('No active game matches that code.'))).toBe(false);
    expect(isHostPlayerConflict(null)).toBe(false);
  });
});
