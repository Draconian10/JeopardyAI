import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, viewSession } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
import { finalSubmissionStatus } from '@/lib/game/final-submissions';
const HOST = crypto.randomUUID(),
  A = crypto.randomUUID(),
  B = crypto.randomUUID(),
  CTRL = crypto.randomUUID(),
  NOW = 100000;
function fixture() {
  const s = createSession(starterBoard(), crypto.randomUUID(), HOST, '123456', NOW, CTRL);
  s.phase = 'finalAnswer';
  s.deadline = NOW + 30000;
  s.players = [A, B].map((id, i) => ({
    id,
    name: i ? 'Sam' : 'Alex',
    score: 100,
    lastSeen: NOW,
    removed: false,
  }));
  s.final = Object.fromEntries(s.players.map((p) => [p.id, { score: 100, wager: 50, text: '' }]));
  return s;
}
function answer(s: ReturnType<typeof fixture>, text: string, now = NOW) {
  return applyCommand(
    s,
    { type: 'answer', text },
    { userId: A, now, actionId: crypto.randomUUID(), expectedVersion: s.actionVersion },
  );
}
describe('Final submission status and privacy', () => {
  it('distinguishes missing, blank received, saved, and judged incorrect independently', () => {
    expect(finalSubmissionStatus({ text: '' })).toBe('No answer received');
    expect(finalSubmissionStatus({ text: ' ', submittedAt: NOW })).toBe('Blank answer saved');
    expect(finalSubmissionStatus({ text: 'Paris', judged: true, correct: false })).toBe(
      'Answer saved',
    );
    expect(finalSubmissionStatus(undefined)).toBe('No answer received');
  });
  it('records server acceptance for blanks and nonblank answers, but rejects late writes', () => {
    const blank = answer(fixture(), '');
    expect(blank.final[A].submittedAt).toBe(NOW);
    const saved = answer(blank, 'Paris', NOW + 1000);
    expect(saved.final[A]).toMatchObject({ text: 'Paris', submittedAt: NOW + 1000 });
    expect(saved.players[0].score).toBe(100);
    expect(() => answer(saved, 'late', NOW + 30000)).toThrow();
  });
  it('keeps other players and audience unaware of unjudged text and submission timestamps', () => {
    const s = answer(fixture(), 'Private answer');
    expect(viewSession(s, HOST, NOW, CTRL).finalEntries[A].submittedAt).toBe(NOW);
    expect(viewSession(s, A, NOW).finalEntries[A].text).toBe('Private answer');
    for (const view of [viewSession(s, B, NOW), viewSession(s, HOST, NOW, CTRL, true)]) {
      expect(view.finalEntries[A].text).toBeUndefined();
      expect(view.finalEntries[A].submittedAt).toBeUndefined();
    }
  });
  it('does not allow a blank received answer to be marked correct and retains it through JSON reload', () => {
    let s = answer(fixture(), ' ');
    s.final[B].judged = true;
    s.phase = 'finalReview';
    s.deadline = undefined;
    s = JSON.parse(JSON.stringify(s));
    expect(finalSubmissionStatus(s.final[A])).toBe('Blank answer saved');
    expect(() =>
      applyCommand(
        s,
        { type: 'finalJudge', playerId: A, correct: true },
        {
          userId: HOST,
          controller: CTRL,
          now: NOW,
          expectedVersion: s.actionVersion,
          actionId: crypto.randomUUID(),
        },
      ),
    ).toThrow('blank answer');
  });
});
