import { describe, it, expect } from 'vitest';
import { playerSessionSummary } from '@/lib/game/player-sessions';
import { createSession } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
const HOST = crypto.randomUUID(),
  PLAYER = crypto.randomUUID();
function fixture() {
  const s = createSession(starterBoard(), crypto.randomUUID(), HOST, '123456', Date.now());
  s.players = [{ id: PLAYER, name: 'Alex', score: 600, lastSeen: Date.now(), removed: false }];
  return s;
}
describe('player return summaries', () => {
  it('returns the existing session identity and score for a joined player', () => {
    const s = fixture();
    expect(playerSessionSummary(s, PLAYER)).toEqual({
      id: s.id,
      title: s.title,
      playerName: 'Alex',
      score: 600,
      phase: 'lobby',
      paused: false,
    });
  });
  it('excludes users who never joined and the host identity', () => {
    const s = fixture();
    expect(playerSessionSummary(s, crypto.randomUUID())).toBeNull();
    expect(playerSessionSummary(s, HOST)).toBeNull();
  });
  it('excludes removed players', () => {
    const s = fixture();
    s.players[0].removed = true;
    expect(playerSessionSummary(s, PLAYER)).toBeNull();
  });
  it('excludes finished and explicitly ended sessions', () => {
    const s = fixture();
    s.phase = 'ended';
    expect(playerSessionSummary(s, PLAYER)).toBeNull();
    s.phase = 'finished';
    expect(playerSessionSummary(s, PLAYER)).toBeNull();
  });
  it('supports paused sessions and negative scores without changing the game', () => {
    const s = fixture();
    s.paused = true;
    s.players[0].score = -200;
    const before = JSON.stringify(s);
    expect(playerSessionSummary(s, PLAYER)).toMatchObject({ paused: true, score: -200 });
    expect(JSON.stringify(s)).toBe(before);
  });
  it('only returns safe summary fields', () => {
    const s = fixture();
    expect(Object.keys(playerSessionSummary(s, PLAYER)!)).toEqual([
      'id',
      'title',
      'playerName',
      'score',
      'phase',
      'paused',
    ]);
    expect(JSON.stringify(playerSessionSummary(s, PLAYER))).not.toContain(
      s.board.questions[0].answer,
    );
  });
});
