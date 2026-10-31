import { describe, expect, it } from 'vitest';
import { applyCommand, createSession, reconcile, viewSession, HOST_GRACE } from '@/lib/game/engine';
import { commandSchema, type Command } from '@/lib/game/schema';
import type { Session } from '@/lib/game/types';
import { starterBoard } from '@/lib/game/starter';
import { rankedStandings } from '@/lib/game/standings';
import { resultsCsv } from '@/lib/game/results-csv';
const HOST = crypto.randomUUID(),
  A = crypto.randomUUID(),
  B = crypto.randomUUID(),
  C = crypto.randomUUID(),
  CONTROL = crypto.randomUUID(),
  NOW = 100000;
function act(s: Session, cmd: Command, userId = HOST, now = NOW, extras = {}) {
  return applyCommand(s, cmd, {
    userId,
    controller: CONTROL,
    now,
    expectedVersion: s.actionVersion,
    actionId: crypto.randomUUID(),
    ...extras,
  });
}
function fixture(allTied = false) {
  const s = createSession(starterBoard(), crypto.randomUUID(), HOST, '001234', NOW, CONTROL);
  s.phase = 'finalReview';
  s.players = [A, B, C].map((id, i) => ({
    id,
    name: ['Alex', 'Sam', 'Pat'][i],
    score: i === 2 && !allTied ? 400 : 1000,
    removed: false,
    lastSeen: NOW,
  }));
  s.final = Object.fromEntries(
    s.players.map((p) => [
      p.id,
      { score: p.score, wager: 0, text: 'answer', judged: true, correct: true },
    ]),
  );
  return s;
}
function clue(s = act(fixture(), { type: 'finish' })) {
  return act(s, {
    type: 'tieClue',
    category: 'World capitals',
    prompt: 'This city is the capital of France.',
    answer: 'What is Paris?',
  });
}
function buzz(s: Session, id = A, now = NOW) {
  return act(s, { type: 'buzz', windowId: s.windowId! }, id, now);
}
describe('sudden death tiebreakers', () => {
  it('consumes saved clues in order exactly once, preserves the queue across resume, and never leaks future clues', () => {
    const board = fixture();
    board.board.tiebreakers = [
      { category: 'First category', prompt: 'First saved prompt', answer: 'Secret one' },
      { category: 'Second category', prompt: 'Second saved prompt', answer: 'Secret two' },
    ];
    let s = act(board, { type: 'finish' });
    const view = viewSession(s, HOST, NOW, CONTROL);
    expect(view.tiebreaker?.savedCluesRemaining).toBe(2);
    expect(view.tiebreaker?.nextSavedCategory).toBe('First category');
    expect(JSON.stringify(viewSession(s, A, NOW))).not.toContain('Second category');
    expect(JSON.stringify(viewSession(s, HOST, NOW, CONTROL, true))).not.toContain('Secret');
    const actionId = crypto.randomUUID();
    s = act(s, { type: 'tieSavedClue' }, HOST, NOW, { actionId });
    s = act(s, { type: 'tieSavedClue' }, HOST, NOW, { actionId });
    expect(s.tiebreaker?.rounds).toHaveLength(1);
    expect(s.tiebreaker?.savedCluesUsed).toBe(1);
    expect(JSON.stringify(viewSession(s, A, NOW))).not.toContain('Secret');
    s = act(s, { type: 'tieReveal' });
    s = act(s, { type: 'tieNext' });
    s = JSON.parse(JSON.stringify(s));
    s = act(s, { type: 'claim', pin: '123456', controller: CONTROL }, HOST, NOW, {
      pinVerified: true,
    });
    s = act(s, { type: 'continue' });
    s = act(s, { type: 'tieSavedClue' });
    expect(s.tiebreaker?.rounds[1].prompt).toBe('Second saved prompt');
    s = act(s, { type: 'tieReveal' });
    s = act(s, { type: 'tieNext' });
    expect(() => act(s, { type: 'tieSavedClue' })).toThrow('No complete saved clue remains');
    expect(clue(s).phase).toBe('tieQuestion');
    expect(() => act(s, { type: 'tieSavedClue' }, A)).toThrow('Only the host');
  });

  it('starts only for tied active leaders after all Final judgments, including negative scores', () => {
    const s = fixture();
    s.players.forEach((p) => (p.score -= 2000));
    const next = act(s, { type: 'finish' });
    expect(next.phase).toBe('tieSetup');
    expect(next.tiebreaker?.playerIds).toEqual([A, B]);
    s.final[A].judged = false;
    expect(() => act(s, { type: 'finish' })).toThrow('Judge every answer');
  });
  it('finishes normally for one leader', () => {
    const s = fixture();
    s.players[0].score++;
    expect(act(s, { type: 'finish' }).phase).toBe('finished');
  });
  it('rejects empty, oversized and extra clue fields', () => {
    for (const patch of [
      { category: ' ' },
      { prompt: '' },
      { answer: 'a'.repeat(2001) },
      { value: 100 },
    ]) {
      expect(
        commandSchema.safeParse({
          type: 'tieClue',
          category: 'C',
          prompt: 'Q',
          answer: 'A',
          ...patch,
        }).success,
      ).toBe(false);
    }
  });
  it('limits buzzing to tied leaders and rejects stale windows and competing buzzes', () => {
    const s = clue();
    expect(() => buzz(s, C)).toThrow('Only tied leaders');
    expect(() => act(s, { type: 'buzz', windowId: crypto.randomUUID() }, A)).toThrow('window');
    expect(() => buzz(buzz(s), B)).toThrow('stage');
    expect(() => act(s, { type: 'tieJudge', correct: true }, A)).toThrow('Only the host');
  });
  it('does not award a default victory after a miss and requires a correct response', () => {
    let s = clue();
    const scores = s.players.map((p) => p.score),
      oldWindow = s.windowId;
    s = act(buzz(s, A, NOW + 1000), { type: 'tieJudge', correct: false }, HOST, NOW + 2000);
    expect(s.phase).toBe('tieQuestion');
    expect(s.remaining).toBe(29000);
    expect(s.tiebreaker?.winnerId).toBeUndefined();
    expect(s.windowId).not.toBe(oldWindow);
    expect(() => buzz(s, A, NOW + 2000)).toThrow('already answered');
    s = act(buzz(s, B, NOW + 2500), { type: 'tieJudge', correct: true }, HOST, NOW + 3000);
    expect(s.phase).toBe('finished');
    expect(s.tiebreaker?.winnerId).toBe(B);
    expect(s.players.map((p) => p.score)).toEqual(scores);
    expect(s.events).toHaveLength(0);
    const view = viewSession(s, HOST, NOW + 3000, CONTROL);
    expect(rankedStandings(view)[0].player.id).toBe(B);
    const csv = resultsCsv(s);
    expect(csv).toContain('Won sudden-death tiebreaker');
    expect(csv).toContain('Tiebreaker response');
    expect(csv).toContain('"1","' + B + '"');
    expect(csv).toContain('"2","' + A + '"');
  });
  it('retains all three tied contestants across clues when everyone misses', () => {
    let s = clue(act(fixture(true), { type: 'finish' }));
    for (const id of [A, B, C]) s = act(buzz(s, id), { type: 'tieJudge', correct: false });
    expect(s.phase).toBe('tieReveal');
    expect(s.tiebreaker?.winnerId).toBeUndefined();
    s = act(s, { type: 'tieNext' });
    s = clue(s);
    expect(s.tiebreaker?.rounds).toHaveLength(2);
    expect(s.attempted).toEqual([]);
    expect(s.tiebreaker?.playerIds).toEqual([A, B, C]);
    expect(buzz(s, A).phase).toBe('tieAnswer');
  });
  it('times out a clue without a winner and preserves it across JSON reloads', () => {
    const s = clue();
    s.hostSeen = NOW + 25000;
    reconcile(s, NOW + 30000);
    expect(s.phase).toBe('tieReveal');
    expect(s.tiebreaker?.winnerId).toBeUndefined();
    const restored = JSON.parse(JSON.stringify(s)) as Session;
    expect(act(restored, { type: 'tieNext' }, HOST, NOW + 30000).phase).toBe('tieSetup');
  });
  it('applies the optional answer deadline without deducting points or awarding a default win', () => {
    let s = clue();
    s.answerLimitSeconds = 5;
    s = buzz(s);
    reconcile(s, NOW + 5000);
    expect(s.phase).toBe('tieQuestion');
    expect(s.players[0].score).toBe(1000);
    expect(s.tiebreaker?.rounds[0].attempts[0]).toMatchObject({ correct: false, timedOut: true });
    expect(s.tiebreaker?.winnerId).toBeUndefined();
  });
  it('freezes and resumes both clue and spoken-answer clocks through host takeover', () => {
    let s = clue();
    s.answerLimitSeconds = 10;
    s = buzz(s, A, NOW + 1000);
    reconcile(s, NOW + HOST_GRACE);
    expect(s.paused).toBe(true); // The answer expires before host loss and reopens the clue.
    expect(s.phase).toBe('tieQuestion');
    s = act(s, { type: 'claim', pin: '123456', controller: CONTROL }, HOST, NOW + 100000, {
      pinVerified: true,
    });
    s = act(s, { type: 'continue' }, HOST, NOW + 100000);
    expect(s.deadline).toBe(NOW + 100000 + s.remaining);
    expect(s.tiebreaker?.playerIds).toEqual([A, B]);
  });
  it('rejects judgments while paused, from a stale controller, and repeat actions after a winner', () => {
    let s = buzz(clue());
    expect(() =>
      act(s, { type: 'tieJudge', correct: true }, HOST, NOW, { controller: crypto.randomUUID() }),
    ).toThrow('read-only');
    s = act(s, { type: 'pause' });
    expect(() => act(s, { type: 'tieJudge', correct: true })).toThrow('paused');
    s = act(s, { type: 'continue' });
    const actionId = crypto.randomUUID();
    const won = act(s, { type: 'tieJudge', correct: true }, HOST, NOW, { actionId });
    expect(act(won, { type: 'tieJudge', correct: true }, HOST, NOW, { actionId })).toEqual(won);
    expect(() => act(won, { type: 'tieNext' })).toThrow('ended');
  });
  it('sanitizes private answers and hides the clue during answering for host and audience', () => {
    const open = clue();
    expect(viewSession(open, A, NOW).tiebreaker?.round?.answer).toBeUndefined();
    expect(viewSession(open, HOST, NOW, CONTROL, true).tiebreaker?.round?.answer).toBeUndefined();
    const answering = buzz(open);
    expect(viewSession(answering, HOST, NOW, CONTROL).tiebreaker?.round?.prompt).toBe('');
    expect(viewSession(answering, HOST, NOW, CONTROL, true).tiebreaker?.round?.prompt).toBe('');
    expect(viewSession(answering, HOST, NOW, CONTROL).tiebreaker?.round?.answer).toBe(
      'What is Paris?',
    );
    const revealed = act(answering, { type: 'tieReveal' });
    expect(viewSession(revealed, B, NOW).tiebreaker?.round?.answer).toBe('What is Paris?');
  });
  it('hides and restores a regular clue through a miss while keeping the host answer private', () => {
    let s = fixture();
    s.phase = 'board';
    s = act(s, { type: 'select', questionId: s.board.questions.find((q) => !q.dailyDouble)!.id });
    const prompt = viewSession(s, HOST, NOW, CONTROL).question!.prompt;
    s = buzz(s);
    expect(viewSession(s, HOST, NOW, CONTROL).question?.prompt).toBe('');
    expect(viewSession(s, HOST, NOW, CONTROL, true).question?.answer).toBeUndefined();
    s = act(s, { type: 'judge', correct: false });
    expect(viewSession(s, HOST, NOW, CONTROL).question?.prompt).toBe(prompt);
    expect(s.phase).toBe('question');
  });
});
