import { expect, it } from 'vitest';
import { parseOptions } from '../scripts/live-browser.mjs';
import { makeTestBoard } from '../scripts/live-game.mjs';
import { playable } from '@/lib/game/schema';
it('requires an explicit safe target and bounded player count', () => {
  for (const args of [
    [],
    ['--url', 'https://user:password@example.com'],
    ['--url', 'https://example.com/path'],
    ['--url', 'http://example.com'],
    ['--url', 'https://example.com', '--players', '100'],
    ['--url', 'https://example.com', '--ending', 'other'],
  ])
    expect(() => parseOptions(args)).toThrow();
  expect(parseOptions(['--url', 'https://example.com', '--players', '15']).players).toBe(15);
});
it('creates a valid complete deterministic test board with private fixture responses', () => {
  const board = makeTestBoard('Controlled test');
  expect(() => playable(board)).not.toThrow();
  expect(board.questions).toHaveLength(30);
  expect(board.tiebreakers).toHaveLength(2);
});
