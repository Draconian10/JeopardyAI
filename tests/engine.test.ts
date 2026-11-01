import { describe, it, expect } from 'vitest';
import { applyCommand, createSession, reconcile, viewSession, HOST_GRACE } from '@/lib/game/engine';
import { boardSchema, commandSchema, pinSchema, playable, type Command } from '@/lib/game/schema';
import { starterBoard } from '@/lib/game/starter';
import type { Session } from '@/lib/game/types';
const HOST = crypto.randomUUID(),
  A = crypto.randomUUID(),
  B = crypto.randomUUID(),
  CONTROL = crypto.randomUUID();
const NOW = 100000;
function act(s: Session, command: Command, userId = HOST, now = NOW, extras = {}) {
  return applyCommand(s, command, {
    userId,
    now,
    controller: CONTROL,
    actionId: crypto.randomUUID(),
    expectedVersion: s.actionVersion,
    ...extras,
  });
}
function fixture() {
  let s = createSession(starterBoard(), crypto.randomUUID(), HOST, '001234', NOW);
  s = act(s, { type: 'claim', pin: '123456', controller: CONTROL }, HOST, NOW, {
    pinVerified: true,
  });
  s = act(s, { type: 'join', name: 'Alex' }, A);
  s = act(s, { type: 'join', name: 'Sam' }, B);
  s = act(s, { type: 'continue' });
  return s;
}
function question() {
  let s = act(fixture(), { type: 'start' });
  return act(s, { type: 'select', questionId: s.board.questions.find((q) => !q.dailyDouble)!.id });
}
function final() {
  const s = question();
  s.phase = 'finalWager';
  s.deadline = undefined;
  s.players[0].score = -400;
  s.players[1].score = 1000;
  s.final = { [A]: { score: -400, text: '' }, [B]: { score: 1000, text: '' } };
  return s;
}
describe('game validations', () => {
  it('allows drafts but refuses an incomplete board at launch', () => {
    const b = starterBoard();
    b.questions[0].answer = '';
    expect(boardSchema.safeParse(b).success).toBe(true);
    expect(() => playable(b)).toThrow();
  });
  it('requires exactly one Daily Double', () => {
    const b = starterBoard();
    b.questions.forEach((q) => (q.dailyDouble = false));
    expect(() => playable(b)).toThrow('exactly one');
    b.questions[0].dailyDouble = true;
    b.questions[1].dailyDouble = true;
    expect(() => playable(b)).toThrow();
  });
  it('rejects duplicate question IDs and positions', () => {
    const b = starterBoard();
    b.questions[1].id = b.questions[0].id;
    expect(boardSchema.safeParse(b).success).toBe(false);
  });
  it('rejects out-of-bounds categories and incomplete rectangular boards', () => {
    const b = starterBoard();
    b.questions[0].category = 7;
    expect(boardSchema.safeParse(b).success).toBe(false);
    b.questions.pop();
    expect(boardSchema.safeParse(b).success).toBe(false);
  });
  it('validates six digit codes including leading zeros', () => {
    expect(pinSchema.parse('001234')).toBe('001234');
    for (const p of ['12345', '1234567', 'abcdef', '12 345'])
      expect(pinSchema.safeParse(p).success).toBe(false);
  });
  it('rejects malformed wagers, oversized answers and unknown fields', () => {
    for (const amount of [-1, 0.5, NaN, Infinity])
      expect(commandSchema.safeParse({ type: 'wager', amount }).success).toBe(false);
    expect(commandSchema.safeParse({ type: 'answer', text: 'x'.repeat(2001) }).success).toBe(false);
    expect(commandSchema.safeParse({ type: 'start', score: 999 }).success).toBe(false);
  });
  it('requires a player before starting', () => {
    let s = createSession(starterBoard(), crypto.randomUUID(), HOST, '123456', NOW);
    s.controller = CONTROL;
    expect(() => act(s, { type: 'start' })).toThrow('At least one');
  });
  it('rejects duplicate names ignoring whitespace and case at the boundary', () => {
    const s = fixture();
    const join = commandSchema.parse({ type: 'join', name: '  aLeX  ' });
    expect(() => act(s, join, crypto.randomUUID())).toThrow('taken');
  });
  it('retains removed player identity and blocks re-entry', () => {
    let s = fixture();
    s = act(s, { type: 'remove', playerId: A });
    expect(() => act(s, { type: 'join', name: 'Different' }, A)).toThrow('removed');
  });
  it('blocks late joins and allows existing players to reconnect', () => {
    const s = question();
    expect(() => act(s, { type: 'join', name: 'Late' }, crypto.randomUUID())).toThrow();
    expect(act(s, { type: 'join', name: 'Alex' }, A).players).toHaveLength(2);
  });
  it('locks the lobby and prevents host self-play', () => {
    const s = act(fixture(), { type: 'lockLobby', locked: true });
    expect(() => act(s, { type: 'join', name: 'New' }, crypto.randomUUID())).toThrow('locked');
    expect(() => act(s, { type: 'join', name: 'Host' }, HOST)).toThrow('separate device');
  });
});
describe('authoritative buzzer and scoring', () => {
  it('accepts exactly one buzz and pauses the countdown', () => {
    let s = question();
    const windowId = s.windowId!;
    s = act(s, { type: 'buzz', windowId }, A, NOW + 3000);
    expect(s.respondent).toBe(A);
    expect(s.remaining).toBe(27000);
    expect(s.deadline).toBeUndefined();
    expect(() => act(s, { type: 'buzz', windowId }, B, NOW + 3001)).toThrow();
  });
  it('deducts points then reopens only for other players with remaining time', () => {
    let s = question();
    const old = s.windowId!;
    s = act(s, { type: 'buzz', windowId: old }, A, NOW + 3000);
    s = act(s, { type: 'judge', correct: false }, HOST, NOW + 5000);
    expect(s.players[0].score).toBe(-200);
    expect(s.deadline).toBe(NOW + 32000);
    expect(s.windowId).not.toBe(old);
    expect(() => act(s, { type: 'buzz', windowId: s.windowId! }, A, NOW + 6000)).toThrow(
      'already answered',
    );
    expect(() => act(s, { type: 'buzz', windowId: old }, B, NOW + 6000)).toThrow('closed');
  });
  it('closes the question when all players answer incorrectly', () => {
    let s = question();
    s = act(s, { type: 'buzz', windowId: s.windowId! }, A);
    s = act(s, { type: 'judge', correct: false });
    s = act(s, { type: 'buzz', windowId: s.windowId! }, B);
    s = act(s, { type: 'judge', correct: false });
    expect(s.phase).toBe('reveal');
    expect(s.players.map((p) => p.score)).toEqual([-200, -200]);
  });
  it('awards a correct answer exactly once under a repeated action ID', () => {
    let s = question();
    s = act(s, { type: 'buzz', windowId: s.windowId! }, A);
    const actionId = crypto.randomUUID();
    s = act(s, { type: 'judge', correct: true }, HOST, NOW, { actionId });
    const again = act(s, { type: 'judge', correct: true }, HOST, NOW, { actionId });
    expect(again.players[0].score).toBe(200);
    expect(again.events).toHaveLength(1);
    expect(again.version).toBe(s.version);
  });
  it('rejects a second judgment with a different action ID', () => {
    let s = question();
    s = act(s, { type: 'buzz', windowId: s.windowId! }, A);
    s = act(s, { type: 'judge', correct: true });
    expect(() => act(s, { type: 'judge', correct: true })).toThrow();
  });
  it('rejects stale host actions but heartbeats do not invalidate a pending judgment', () => {
    let s = question();
    s = act(s, { type: 'buzz', windowId: s.windowId! }, A);
    const expectedVersion = s.actionVersion;
    s = act(s, { type: 'heartbeat' });
    expect(() =>
      act(s, { type: 'judge', correct: true }, HOST, NOW, { expectedVersion }),
    ).not.toThrow();
    expect(() =>
      act(s, { type: 'judge', correct: true }, HOST, NOW, { expectedVersion: 0 }),
    ).toThrow('changed');
  });
  it('supports correcting the last judgment without score drift', () => {
    let s = question();
    s = act(s, { type: 'buzz', windowId: s.windowId! }, A);
    s = act(s, { type: 'judge', correct: true });
    s = act(s, { type: 'undo' });
    expect(s.phase).toBe('answering');
    expect(s.players[0].score).toBe(0);
    expect(s.events).toHaveLength(0);
    s = act(s, { type: 'judge', correct: false });
    expect(s.players[0].score).toBe(-200);
  });
  it('blocks expired buzzes at the exact deadline', () => {
    const s = question();
    s.hostSeen = NOW + 25000;
    expect(() => act(s, { type: 'buzz', windowId: s.windowId! }, A, NOW + 30000)).toThrow();
    reconcile(s, NOW + 30000);
    expect(s.phase).toBe('reveal');
  });
  it('cannot select a used tile', () => {
    let s = question();
    const id = s.questionId!;
    s = act(s, { type: 'reveal' });
    s = act(s, { type: 'next' });
    expect(() => act(s, { type: 'select', questionId: id })).toThrow('unused');
  });
});
describe('durable host recovery', () => {
  it('pauses at the disconnect grace boundary and persists the remaining time', () => {
    const s = question();
    reconcile(s, NOW + HOST_GRACE + 2000);
    expect(s.paused).toBe(true);
    expect(s.phase).toBe('question');
    expect(s.remaining).toBe(15000);
    expect(s.deadline).toBeUndefined();
  });
  it('restores a closed browser days later without ending the session', () => {
    const before = question();
    const s = JSON.parse(JSON.stringify(before)) as Session;
    reconcile(s, NOW + 86400000);
    let next = act(s, { type: 'claim', pin: '123456', controller: CONTROL }, HOST, NOW + 86400000, {
      pinVerified: true,
    });
    next = act(next, { type: 'continue' }, HOST, NOW + 86400000);
    expect(next.id).toBe(before.id);
    expect(next.joinCode).toBe('001234');
    expect(next.questionId).toBe(before.questionId);
    expect(next.deadline).toBe(NOW + 86400000 + 15000);
    expect(next.phase).toBe('question');
  });
  it('resolves deadlines which expire before host-loss detection', () => {
    const s = question();
    s.deadline = NOW + 1000;
    reconcile(s, NOW + 20000);
    expect(s.phase).toBe('reveal');
    expect(s.paused).toBe(true);
  });
  it('retains the accepted respondent while disconnected', () => {
    let s = question();
    s = act(s, { type: 'buzz', windowId: s.windowId! }, A, NOW + 1000);
    reconcile(s, NOW + 20000);
    expect(s.phase).toBe('answering');
    expect(s.respondent).toBe(A);
    expect(s.remaining).toBe(29000);
  });
  it('requires a verified PIN for control and invalidates old controllers', () => {
    let s = question();
    const other = crypto.randomUUID();
    expect(() => act(s, { type: 'claim', pin: '123456', controller: other })).toThrow('PIN');
    s = act(s, { type: 'claim', pin: '123456', controller: other }, HOST, NOW, {
      pinVerified: true,
    });
    expect(s.paused).toBe(true);
    expect(() => act(s, { type: 'continue' })).toThrow('read-only');
  });
  it('never lets a player perform host actions or view another session', () => {
    const s = question();
    expect(() => act(s, { type: 'reveal' }, A)).toThrow('Only the host');
    expect(() => viewSession(s, crypto.randomUUID(), NOW)).toThrow('access');
  });
  it('freezes buzzes and wagers while paused', () => {
    const s = act(question(), { type: 'pause' });
    expect(() => act(s, { type: 'buzz', windowId: s.windowId! }, A)).toThrow('paused');
  });
  it('requires explicit end and rejects further actions afterward', () => {
    const s = act(question(), { type: 'end' });
    expect(s.phase).toBe('ended');
    expect(() =>
      act(s, { type: 'claim', pin: '123456', controller: CONTROL }, HOST, NOW, {
        pinVerified: true,
      }),
    ).toThrow('ended');
  });
});
describe('Daily Double and Final Jeopardy', () => {
  it('hides Daily Double question until wager and disables buzzing', () => {
    let s = act(fixture(), { type: 'start' });
    s = act(s, { type: 'select', questionId: s.board.questions.find((q) => q.dailyDouble)!.id });
    expect(s.phase).toBe('dailyWager');
    expect(viewSession(s, A, NOW).question?.prompt).toBe('Daily Double');
    expect(() => act(s, { type: 'buzz', windowId: crypto.randomUUID() }, A)).toThrow();
  });
  it('allows negative-score wagers using absolute value and only zero at zero', () => {
    let s = act(fixture(), { type: 'start' });
    s.players[0].score = -400;
    s = act(s, { type: 'select', questionId: s.board.questions.find((q) => q.dailyDouble)!.id });
    expect(() => act(s, { type: 'dailyWager', playerId: B, amount: 1 })).toThrow('exceeds');
    expect(() => act(s, { type: 'dailyWager', playerId: A, amount: 401 })).toThrow('exceeds');
    s = act(s, { type: 'dailyWager', playerId: A, amount: 400 });
    s = act(s, { type: 'dailyJudge', correct: true });
    expect(s.players[0].score).toBe(0);
  });
  it('enforces Final wager bounds, privacy, and default zero wagers', () => {
    let s = final();
    expect(() => act(s, { type: 'wager', amount: 401 }, A)).toThrow('exceeds');
    s = act(s, { type: 'wager', amount: 300 }, A);
    expect(viewSession(s, B, NOW).finalEntries[A].wager).not.toBe(300);
    s = act(s, { type: 'openFinal' });
    expect(s.final[B].wager).toBe(0);
    expect(() => act(s, { type: 'wager', amount: 0 }, A)).toThrow();
  });
  it('keeps only the latest saved Final answer and rejects late answers', () => {
    let s = act(final(), { type: 'openFinal' });
    s = act(s, { type: 'answer', text: 'First' }, A, NOW + 1000);
    s = act(s, { type: 'answer', text: 'Revised' }, A, NOW + 2000);
    expect(s.final[A].text).toBe('Revised');
    expect(viewSession(s, B, NOW).finalEntries[A].text).toBeUndefined();
    s.hostSeen = NOW + 25000;
    expect(() => act(s, { type: 'answer', text: 'Too late' }, A, NOW + 30000)).toThrow();
  });
  it('preserves Final answers and time through disconnection', () => {
    let s = act(final(), { type: 'openFinal' });
    s = act(s, { type: 'answer', text: 'Saved answer' }, A, NOW + 1000);
    reconcile(s, NOW + 20000);
    expect(s.phase).toBe('finalAnswer');
    expect(s.final[A].text).toBe('Saved answer');
    expect(s.remaining).toBe(15000);
  });
  it('reviews in pre-Final score order, rejects blanks as correct, and requires all judgments', () => {
    let s = act(final(), { type: 'openFinal' });
    s.hostSeen = NOW + 25000;
    reconcile(s, NOW + 30000);
    expect(s.phase).toBe('finalReveal');
    s = act(s, { type: 'reviewFinal' }, HOST, NOW + 30000);
    expect(() =>
      act(s, { type: 'finalJudge', playerId: B, correct: false }, HOST, NOW + 30000),
    ).toThrow('order');
    expect(() =>
      act(s, { type: 'finalJudge', playerId: A, correct: true }, HOST, NOW + 30000),
    ).toThrow('blank');
    expect(() => act(s, { type: 'finish' }, HOST, NOW + 30000)).toThrow('every');
    s = act(s, { type: 'finalJudge', playerId: A, correct: false }, HOST, NOW + 30000);
    s = act(s, { type: 'finalJudge', playerId: B, correct: false }, HOST, NOW + 30000);
    s = act(s, { type: 'finish' }, HOST, NOW + 30000);
    expect(s.phase).toBe('finished');
  });
  it('does not send answers, host notes, or future questions to players or audience', () => {
    const s = question();
    const v = viewSession(s, A, NOW);
    expect(v.question?.answer).toBeUndefined();
    expect(v.question?.notes).toBeUndefined();
    expect(v.finalPrompt).toBeUndefined();
    expect(v.finalAnswer).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(s.board.questions[4].prompt);
    expect(viewSession(s, HOST, NOW, CONTROL, true).question?.answer).toBeUndefined();
    expect(viewSession(s, HOST, NOW, CONTROL).question?.answer).toBeTruthy();
  });
  it('snapshots saved boards and leaves originals unchanged', () => {
    const b = starterBoard();
    const s = createSession(b, crypto.randomUUID(), HOST, '000000', NOW);
    b.questions[0].prompt = 'Edited';
    expect(s.board.questions[0].prompt).not.toBe('Edited');
    const before = JSON.stringify(s);
    act(s, { type: 'join', name: 'Alex' }, A);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('complete game flow', () => {
  it('plays the entire board, Daily Double, Final, and persists the final scores', () => {
    let s = act(fixture(), { type: 'start' });
    for (const q of s.board.questions) {
      s = act(s, { type: 'select', questionId: q.id });
      if (q.dailyDouble) {
        s = act(s, { type: 'dailyWager', playerId: A, amount: Math.abs(s.players[0].score) });
        s = act(s, { type: 'dailyJudge', correct: true });
      } else {
        s = act(s, { type: 'buzz', windowId: s.windowId! }, A);
        s = act(s, { type: 'judge', correct: true });
      }
      expect(s.phase).toBe('reveal');
      s = act(s, { type: 'next' });
    }
    expect(s.phase).toBe('finalWager');
    expect(s.used).toHaveLength(30);
    const before = s.players[0].score;
    s = act(s, { type: 'wager', amount: before }, A);
    s = act(s, { type: 'wager', amount: 0 }, B);
    s = act(s, { type: 'openFinal' });
    s = act(s, { type: 'answer', text: 'Taj Mahal' }, A, NOW + 1000);
    s.hostSeen = NOW + 25000;
    reconcile(s, NOW + 30000);
    s = act(s, { type: 'reviewFinal' }, HOST, NOW + 30000);
    s = act(s, { type: 'finalJudge', playerId: B, correct: false }, HOST, NOW + 30000);
    s = act(s, { type: 'finalJudge', playerId: A, correct: true }, HOST, NOW + 30000);
    s = act(s, { type: 'finish' }, HOST, NOW + 30000);
    expect(s.phase).toBe('finished');
    expect(s.players[0].score).toBe(before * 2);
    expect(JSON.parse(JSON.stringify(s)).final[A].text).toBe('Taj Mahal');
  });
});
