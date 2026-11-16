import { describe, it, expect } from 'vitest';
import {
  applyCommand,
  createSession,
  viewSession,
  activeBoard,
  reconcile,
} from '@/lib/game/engine';
import { playable, boardSchema, type Command } from '@/lib/game/schema';
import { starterBoard } from '@/lib/game/starter';
import { boardToQuestionJson, questionJsonToBoard } from '@/lib/game/question-json';
import { resultsCsv } from '@/lib/game/results-csv';
import type { Context, Session } from '@/lib/game/types';
const HOST = crypto.randomUUID(),
  A = crypto.randomUUID(),
  B = crypto.randomUUID(),
  CTRL = crypto.randomUUID(),
  NOW = 100000;
function act(s: Session, cmd: Command, userId = HOST, extra: Partial<Context> = {}) {
  return applyCommand(s, cmd, {
    userId,
    now: NOW,
    controller: CTRL,
    actionId: crypto.randomUUID(),
    expectedVersion: s.actionVersion,
    ...extra,
  });
}
function board() {
  const b = starterBoard(),
    second = starterBoard();
  b.questions = b.questions
    .filter((q) => q.category === 0 && q.row < 2)
    .map((q, i) => ({ ...q, dailyDouble: i === 0 }));
  b.categories = [b.categories[0]];
  b.rows = 2;
  b.doubleJeopardy = {
    categories: ['Second board secret category'],
    rows: 3,
    questions: second.questions
      .filter((q) => q.category === 0 && q.row < 3)
      .map((q, i) => ({
        ...q,
        value: q.value * 2,
        dailyDouble: i < 2,
        prompt: `Second board private clue ${i}`,
        answer: `Second board private answer ${i}`,
      })),
  };
  return b;
}
function game(two = true) {
  const b = board();
  if (!two) delete b.doubleJeopardy;
  let s = createSession(b, crypto.randomUUID(), HOST, '123456', NOW, CTRL);
  s = act(s, { type: 'join', name: 'Alex' }, A);
  s = act(s, { type: 'join', name: 'Sam' }, B);
  return act(s, { type: 'start' });
}
function consumeRound(s: Session) {
  for (const q of activeBoard(s).questions) {
    s = act(s, { type: 'select', questionId: q.id });
    s = act(s, { type: 'reveal' });
    s = act(s, { type: 'next' });
  }
  return s;
}
function review() {
  const s = game();
  s.phase = 'finalReview';
  s.players[0].score = 1000;
  s.players[1].score = 1000;
  s.final = {
    [A]: { score: 1000, wager: 200, text: 'Alex response' },
    [B]: { score: 1000, wager: 200, text: 'Sam response' },
  };
  return s;
}
describe('optional second board', () => {
  it('keeps single-board sessions on their original path and does not require new saved fields', () => {
    let s = game(false);
    expect(s.round).toBeUndefined();
    s = consumeRound(s);
    expect(s.phase).toBe('finalWager');
    expect(s.board.doubleJeopardy).toBeUndefined();
    expect(() => act(s, { type: 'startDouble' })).toThrow();
    expect(boardToQuestionJson(s.board)).not.toHaveProperty('doubleJeopardy');
  });
  it('round-trips both boards, fresh IDs, saved tiebreakers and shared Final JSON', () => {
    const original = boardToQuestionJson(board());
    const restored = questionJsonToBoard(original);
    expect(boardToQuestionJson(restored)).toEqual(original);
    expect(restored.doubleJeopardy?.questions[0].id).not.toBe(
      board().doubleJeopardy?.questions[0].id,
    );
    expect(restored.doubleJeopardy?.questions.filter((q) => q.dailyDouble)).toHaveLength(2);
  });
  it('validates both boards, independent rectangles, unique IDs, strict keys and Daily Double counts', () => {
    const b = board();
    b.doubleJeopardy!.questions[0].id = b.questions[0].id;
    expect(boardSchema.safeParse(b).success).toBe(false);
    const json = boardToQuestionJson(board());
    const fewer = structuredClone(json);
    fewer.doubleJeopardy!.categories[0].questions[0].dailyDouble = false;
    expect(() => questionJsonToBoard(fewer)).toThrow('exactly two');
    const extra = structuredClone(json);
    extra.doubleJeopardy!.categories[0].questions[2].dailyDouble = true;
    expect(() => questionJsonToBoard(extra)).toThrow('exactly two');
    const invalid = board();
    invalid.doubleJeopardy!.questions[0].answer = '';
    expect(() => playable(invalid)).toThrow('Double Jeopardy');
    expect(() =>
      questionJsonToBoard({
        ...json,
        doubleJeopardy: { ...json.doubleJeopardy, final: json.final },
      }),
    ).toThrow();
  });
  it('preserves scores, used tiles, events and standings break, then selects the lowest scorer once', () => {
    let s = game();
    s.players[0].score = 800;
    s.players[1].score = -200;
    s = consumeRound(s);
    expect(s.phase).toBe('roundBreak');
    expect(s.final).toEqual({});
    const used = [...s.used];
    const next = s.board.doubleJeopardy!.questions[0];
    expect(() => act(s, { type: 'select', questionId: next.id })).toThrow();
    expect(() => act(s, { type: 'startDouble' }, A)).toThrow('Only the host');
    s = act(s, { type: 'pause' });
    expect(() => act(s, { type: 'startDouble' })).toThrow('paused');
    s = act(s, { type: 'claim', pin: '123456', controller: CTRL }, HOST, { pinVerified: true });
    s = act(s, { type: 'continue' });
    s = act(s, { type: 'startDouble' });
    expect(s.round).toBe(2);
    expect(s.nextSelectorId).toBe(B);
    expect(s.used).toEqual(used);
    expect(s.players.map((p) => p.score)).toEqual([800, -200]);
    expect(() => act(s, { type: 'startDouble' })).toThrow();
    expect(() => act(s, { type: 'select', questionId: used[0] })).toThrow('unused');
    s = act(s, { type: 'select', questionId: next.id });
    expect(s.daily?.playerId).toBe(B);
    s = act(s, { type: 'dailyWager', amount: 100 }, B);
    s = act(s, { type: 'openDaily' });
    s = act(s, { type: 'dailyJudge', correct: true });
    expect(s.players[1].score).toBe(-100);
    s = act(s, { type: 'undo' });
    expect(s.players[1].score).toBe(-200);
    expect(s.round).toBe(2);
    s = act(s, { type: 'dailyJudge', correct: true });
    s = act(s, { type: 'next' });
    for (const q of s.board.doubleJeopardy!.questions.slice(1)) {
      s = act(s, { type: 'select', questionId: q.id });
      s = act(s, { type: 'reveal' });
      s = act(s, { type: 'next' });
    }
    expect(s.phase).toBe('finalWager');
    expect(s.final[B].score).toBe(-100);
    expect(s.used).toHaveLength(5);
    expect(resultsCsv(s)).toContain('Second board private clue 0');
    expect(resultsCsv(s)).toContain('Second board secret category');
  });
  it('projects only the active board and never leaks future clues or answers to audience or players', () => {
    let s = game();
    for (const user of [HOST, A]) {
      const v = viewSession(s, user, NOW, undefined, true);
      expect(JSON.stringify(v)).not.toContain('Second board');
      expect(v.hasDoubleJeopardy).toBe(true);
    }
    s = consumeRound(s);
    s = act(s, { type: 'startDouble' });
    const v = viewSession(s, A, NOW);
    expect(v.round).toBe(2);
    expect(v.tiles).toHaveLength(3);
    expect(JSON.stringify(v)).not.toContain('private clue');
    expect(JSON.stringify(v)).not.toContain('private answer');
  });
});
describe('Final judgment corrections before confirmation', () => {
  it('supports multiple reversible corrections with exact deltas, unchanged answers and no double application', () => {
    let s = act(review(), { type: 'finalJudge', playerId: [A, B].sort()[0], correct: false });
    const id = [A, B].sort()[0];
    const response = structuredClone(s.final[id]);
    const before = s;
    const actionId = crypto.randomUUID();
    s = act(s, { type: 'correctFinal', playerId: id, correct: true }, HOST, { actionId });
    expect(s.players.find((p) => p.id === id)?.score).toBe(1200);
    expect(s.events.at(-1)?.delta).toBe(400);
    expect(s.final[id].text).toBe(response.text);
    expect(s.final[id].wager).toBe(200);
    expect(
      act(s, { type: 'correctFinal', playerId: id, correct: true }, HOST, { actionId }).players,
    ).toEqual(s.players);
    expect(() => act(s, { type: 'correctFinal', playerId: id, correct: true })).toThrow(
      'already applied',
    );
    expect(() =>
      act(s, { type: 'correctFinal', playerId: id, correct: false }, HOST, {
        expectedVersion: before.actionVersion,
      }),
    ).toThrow('game changed');
    s = act(s, { type: 'correctFinal', playerId: id, correct: false });
    expect(s.players.find((p) => p.id === id)?.score).toBe(800);
    expect(s.events.filter((e) => e.playerId === id).reduce((n, e) => n + e.delta, 0)).toBe(-200);
    expect(resultsCsv(s)).toContain('judgment correction');
  });
  it('recomputes ties only at confirmation and prevents corrections after tie setup or normal finish', () => {
    let s = review();
    for (const id of [A, B].sort()) s = act(s, { type: 'finalJudge', playerId: id, correct: true });
    expect(s.phase).toBe('finalReview');
    const tied = act(s, { type: 'finish' });
    expect(tied.phase).toBe('tieSetup');
    expect(tied.tiebreaker?.playerIds).toHaveLength(2);
    expect(() => act(tied, { type: 'correctFinal', playerId: A, correct: false })).toThrow();
    s = act(s, { type: 'correctFinal', playerId: A, correct: false });
    const won = act(s, { type: 'finish' });
    expect(won.phase).toBe('finished');
    expect(won.tiebreaker).toBeUndefined();
    expect(() => act(won, { type: 'correctFinal', playerId: A, correct: true })).toThrow('ended');
    const retied = act(s, { type: 'correctFinal', playerId: A, correct: true });
    expect(act(retied, { type: 'finish' }).phase).toBe('tieSetup');
  });
  it('rejects unauthorized, unjudged, paused and blank-to-correct changes; zero wagers are safe', () => {
    let s = review();
    expect(() => act(s, { type: 'correctFinal', playerId: A, correct: true })).toThrow(
      'already judged',
    );
    for (const id of [A, B].sort())
      s = act(s, { type: 'finalJudge', playerId: id, correct: false });
    expect(() => act(s, { type: 'correctFinal', playerId: A, correct: true }, A)).toThrow(
      'Only the host',
    );
    expect(() =>
      act(s, { type: 'correctFinal', playerId: A, correct: true }, HOST, {
        controller: crypto.randomUUID(),
      }),
    ).toThrow('read-only');
    const paused = act(s, { type: 'pause' });
    expect(() => act(paused, { type: 'correctFinal', playerId: A, correct: true })).toThrow(
      'paused',
    );
    s.final[A].text = '';
    expect(() => act(s, { type: 'correctFinal', playerId: A, correct: true })).toThrow('blank');
    s.final[B].wager = 0;
    const score = s.players[1].score;
    s = act(s, { type: 'correctFinal', playerId: B, correct: true });
    expect(s.players[1].score).toBe(score);
    expect(s.final[B].correct).toBe(true);
  });
});

it('runs fifteen seats through both boards, all Final submissions, correction and confirmation', () => {
  let s = game();
  // Additional players join only in the lobby, before actual start.
  s.phase = 'lobby';
  s.locked = false;
  const others = Array.from({ length: 13 }, () => crypto.randomUUID());
  for (const [i, id] of others.entries()) s = act(s, { type: 'join', name: `Player ${i + 3}` }, id);
  s = act(s, { type: 'start' });
  for (const p of s.players) p.score = 1000;
  const ids = s.players.map((p) => p.id);
  let turn = 0;
  for (let round = 0; round < 2; round++) {
    for (const q of activeBoard(s).questions) {
      s = act(s, { type: 'select', questionId: q.id });
      if (q.dailyDouble) {
        s = act(s, { type: 'dailyWager', amount: 100 }, s.daily!.playerId);
        s = act(s, { type: 'openDaily' });
        s = act(s, { type: 'dailyJudge', correct: true });
      } else {
        s = act(s, { type: 'buzz', windowId: s.windowId! }, ids[turn++ % ids.length]);
        s = act(s, { type: 'judge', correct: true });
      }
      s = act(s, { type: 'next' });
    }
    if (round === 0) {
      expect(s.phase).toBe('roundBreak');
      s = act(s, { type: 'startDouble' });
    }
  }
  expect(s.phase).toBe('finalWager');
  for (const id of ids) s = act(s, { type: 'wager', amount: 100 }, id);
  s = act(s, { type: 'openFinal' });
  for (const id of ids)
    s = act(s, { type: 'answer', text: `Final response ${id}`, revision: 1 }, id);
  s.hostSeen = NOW + 20000;
  reconcile(s, NOW + 30000);
  expect(s.phase).toBe('finalReveal');
  const later = { now: NOW + 30000 };
  s = act(s, { type: 'reviewFinal' }, HOST, later);
  while (s.players.some((p) => !s.final[p.id].judged)) {
    const id = viewSession(s, HOST, NOW + 30000, CTRL).finalReviewPlayer!;
    s = act(s, { type: 'finalJudge', playerId: id, correct: true }, HOST, later);
  }
  s = act(s, { type: 'correctFinal', playerId: ids[0], correct: false }, HOST, later);
  expect(Object.values(s.final).every((e) => e.text && e.judged)).toBe(true);
  s = act(s, { type: 'finish' }, HOST, later);
  expect(['finished', 'tieSetup']).toContain(s.phase);
  expect(s.used).toHaveLength(5);
  expect(s.players).toHaveLength(15);
});
