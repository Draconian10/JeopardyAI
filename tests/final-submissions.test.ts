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
    expect(finalSubmissionStatus({ text: '' })).toBe('No response received');
    expect(finalSubmissionStatus({ text: ' ', submittedAt: NOW })).toBe('Blank response saved');
    expect(finalSubmissionStatus({ text: 'Paris', judged: true, correct: false })).toBe(
      'Response saved',
    );
    expect(finalSubmissionStatus(undefined)).toBe('No response received');
  });
  it('records server acceptance for blanks and nonblank responses, but rejects late writes', () => {
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
    expect(finalSubmissionStatus(s.final[A])).toBe('Blank response saved');
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
    ).toThrow('blank response');
  });
});

describe('Final review public reveal', () => {
  it('reveals only the current review answer and wager, without exposing the solution or timestamps', () => {
    const s = fixture();
    s.phase = 'finalReview';
    s.deadline = undefined;
    s.final[A] = { score: 100, wager: 25, text: 'Jon submitted this', submittedAt: NOW };
    s.final[B] = { score: 200, wager: 50, text: 'Future private response', submittedAt: NOW };
    const audience = viewSession(s, HOST, NOW, CTRL, true);
    expect(audience.finalReviewPlayer).toBe(A);
    expect(audience.finalEntries[A]).toMatchObject({ text: 'Jon submitted this', wager: 25 });
    expect(audience.finalEntries[A].submittedAt).toBeUndefined();
    expect(audience.finalEntries[B].text).toBeUndefined();
    expect(viewSession(s, A, NOW).finalEntries[B].text).toBeUndefined();
    expect(audience.finalAnswer).toBe(s.board.final.answer);
    s.phase = 'finalAnswer';
    s.deadline = NOW + 30000;
    expect(viewSession(s, HOST, NOW, CTRL, true).finalAnswer).toBeUndefined();
    expect(viewSession(s, HOST, NOW, CTRL, true).finalEntries[A].text).toBeUndefined();
  });
  it('advances the public answer after judging and retains earlier reviewed responses', () => {
    let s = fixture();
    s.phase = 'finalReview';
    s.deadline = undefined;
    s.final[A] = { score: 100, wager: 25, text: 'First response' };
    s.final[B] = { score: 200, wager: 50, text: 'Second response' };
    s = applyCommand(
      s,
      { type: 'finalJudge', playerId: A, correct: false },
      {
        userId: HOST,
        controller: CTRL,
        now: NOW,
        actionId: crypto.randomUUID(),
        expectedVersion: s.actionVersion,
      },
    );
    const audience = viewSession(s, HOST, NOW, CTRL, true);
    expect(audience.finalReviewPlayer).toBe(B);
    expect(audience.finalEntries[B].text).toBe('Second response');
    expect(audience.finalEntries[A]).toMatchObject({
      text: 'First response',
      judged: true,
      correct: false,
    });
  });
});

describe('correct response before individual Final review', () => {
  it('reveals the solution without revealing contestant responses until the host continues', () => {
    let s = answer(fixture(), 'Private response');
    s.phase = 'finalReveal';
    s.deadline = undefined;
    const audience = viewSession(s, HOST, NOW, CTRL, true);
    expect(audience.finalAnswer).toBe(s.board.final.answer);
    expect(audience.finalReviewPlayer).toBeUndefined();
    expect(audience.finalEntries[A].text).toBeUndefined();
    const ctx = {
      userId: HOST,
      controller: CTRL,
      now: NOW,
      expectedVersion: s.actionVersion,
      actionId: crypto.randomUUID(),
    };
    expect(() => applyCommand(s, { type: 'finalJudge', playerId: A, correct: false }, ctx)).toThrow(
      'stage',
    );
    expect(() =>
      applyCommand(s, { type: 'answer', text: 'Late' }, { ...ctx, userId: A }),
    ).toThrow();
    expect(() => applyCommand(s, { type: 'reviewFinal' }, { ...ctx, userId: A })).toThrow(
      'Only the host',
    );
    s = applyCommand(s, { type: 'pause' }, ctx);
    s = JSON.parse(JSON.stringify(s));
    expect(s.phase).toBe('finalReveal');
    expect(() =>
      applyCommand(
        s,
        { type: 'reviewFinal' },
        { ...ctx, expectedVersion: s.actionVersion, actionId: crypto.randomUUID() },
      ),
    ).toThrow('paused');
    s = applyCommand(
      s,
      { type: 'continue' },
      { ...ctx, expectedVersion: s.actionVersion, actionId: crypto.randomUUID() },
    );
    s = applyCommand(
      s,
      { type: 'reviewFinal' },
      { ...ctx, expectedVersion: s.actionVersion, actionId: crypto.randomUUID() },
    );
    expect(s.phase).toBe('finalReview');
    expect(s.players[0].score).toBe(100);
  });
});
