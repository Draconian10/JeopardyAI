import { describe, it, expect } from 'vitest';
import { applyCommand, createSession, reconcile, viewSession } from '@/lib/game/engine';
import { commandSchema, type Command } from '@/lib/game/schema';
import { starterBoard } from '@/lib/game/starter';
import { rankedStandings } from '@/lib/game/standings';
import type { Session } from '@/lib/game/types';
const HOST = crypto.randomUUID(),
  A = crypto.randomUUID(),
  B = crypto.randomUUID(),
  CTRL = crypto.randomUUID(),
  NOW = 100000;
function act(s: Session, cmd: Command, userId = HOST, now = NOW, extra = {}) {
  return applyCommand(s, cmd, {
    userId,
    now,
    controller: CTRL,
    actionId: crypto.randomUUID(),
    expectedVersion: s.actionVersion,
    ...extra,
  });
}
function lobby() {
  let s = createSession(starterBoard(), crypto.randomUUID(), HOST, '123456', NOW);
  s.controller = CTRL;
  s = act(s, { type: 'join', name: 'Alex' }, A);
  s = act(s, { type: 'join', name: 'Sam' }, B);
  return s;
}
function question(seconds = 0) {
  let s = act(lobby(), { type: 'configure', answerLimitSeconds: seconds });
  s = act(s, { type: 'start' });
  return act(s, { type: 'select', questionId: s.board.questions[0].id });
}
function answering(seconds = 10) {
  let s = question(seconds);
  return act(s, { type: 'buzz', windowId: s.windowId! }, A, NOW + 1000);
}
describe('dashboard ending', () => {
  it('allows the owner to end without a controller, PIN, or current gameplay version', () => {
    const s = lobby();
    s.paused = true;
    const next = act(s, { type: 'end' }, HOST, NOW, {
      controller: undefined,
      expectedVersion: -1,
      dashboardEnd: true,
    });
    expect(next.phase).toBe('ended');
    expect(next.players).toEqual(s.players);
    expect(next.locked).toBe(true);
  });
  it('blocks players from using the dashboard context', () => {
    expect(() =>
      act(lobby(), { type: 'end' }, A, NOW, { dashboardEnd: true, controller: undefined }),
    ).toThrow('Only the host');
  });
  it('keeps normal end commands controller-protected and rejects generic bypass payloads', () => {
    expect(() => act(lobby(), { type: 'end' }, HOST, NOW, { controller: undefined })).toThrow(
      'read-only',
    );
    expect(commandSchema.safeParse({ type: 'end', dashboardEnd: true }).success).toBe(false);
  });
  it('is safe to retry after the session ends', () => {
    let s = act(lobby(), { type: 'end' }, HOST, NOW, { dashboardEnd: true });
    const before = JSON.stringify(s);
    s = act(s, { type: 'end' }, HOST, NOW, { dashboardEnd: true });
    expect(JSON.stringify(s)).toBe(before);
  });
  it('preserves pending Final answers and current scores while ending', () => {
    const s = lobby();
    s.phase = 'finalAnswer';
    s.players[0].score = -300;
    s.final = { [A]: { score: -300, wager: 200, text: 'Saved answer' } };
    s.deadline = NOW + 30000;
    const next = act(s, { type: 'end' }, HOST, NOW, { dashboardEnd: true, controller: undefined });
    expect(next.final[A].text).toBe('Saved answer');
    expect(next.players[0].score).toBe(-300);
    expect(next.deadline).toBeUndefined();
  });
});
describe('practice buzzer', () => {
  it('arbitrates a winner with no scores, score events, or used tiles', () => {
    let s = act(lobby(), { type: 'practiceStart' });
    const window = s.windowId!;
    s = act(s, { type: 'buzz', windowId: window }, A, NOW + 1000);
    expect(s.phase).toBe('practiceAnswer');
    expect(s.respondent).toBe(A);
    expect(s.events).toHaveLength(0);
    expect(s.used).toHaveLength(0);
    expect(s.players.map((p) => p.score)).toEqual([0, 0]);
    expect(() => act(s, { type: 'buzz', windowId: window }, B, NOW + 1000)).toThrow();
    expect(() => act(s, { type: 'judge', correct: true })).toThrow();
  });
  it('resets with a new window, then returns to a clean lobby before actual play', () => {
    let s = act(lobby(), { type: 'practiceStart' });
    const old = s.windowId!;
    s = act(s, { type: 'buzz', windowId: old }, A);
    s = act(s, { type: 'practiceStart' });
    expect(s.windowId).not.toBe(old);
    expect(() => act(s, { type: 'buzz', windowId: old }, B)).toThrow('closed');
    s = act(s, { type: 'practiceStop' });
    expect(s.phase).toBe('lobby');
    expect(s.respondent).toBeUndefined();
    s = act(s, { type: 'start' });
    expect(s.phase).toBe('board');
    expect(s.used).toHaveLength(0);
  });
  it('allows new players to join practice if the lobby is unlocked', () => {
    let s = act(lobby(), { type: 'practiceStart' });
    s = act(s, { type: 'join', name: 'New player' }, crypto.randomUUID());
    expect(s.players).toHaveLength(3);
    s = act(s, { type: 'lockLobby', locked: true });
    expect(() => act(s, { type: 'join', name: 'Blocked' }, crypto.randomUUID())).toThrow('locked');
  });
  it('expires without scoring and can be reset', () => {
    const s = act(lobby(), { type: 'practiceStart' });
    s.hostSeen = NOW + 25000;
    reconcile(s, NOW + 30000);
    expect(s.phase).toBe('practiceReady');
    expect(s.players[0].score).toBe(0);
    expect(act(s, { type: 'practiceStart' }, HOST, NOW + 30000).phase).toBe('practiceOpen');
  });
  it('preserves a practice winner through host disconnection and JSON restoration', () => {
    let s = act(lobby(), { type: 'practiceStart' });
    s = act(s, { type: 'buzz', windowId: s.windowId! }, B);
    const restored = JSON.parse(JSON.stringify(s));
    reconcile(restored, NOW + 20000);
    expect(restored.paused).toBe(true);
    expect(restored.respondent).toBe(B);
    expect(restored.phase).toBe('practiceAnswer');
  });
  it('rejects practice during scored play and player-issued resets', () => {
    expect(() => act(question(), { type: 'practiceStart' })).toThrow();
    expect(() => act(lobby(), { type: 'practiceStart' }, A)).toThrow('Only the host');
  });
});
describe('optional answer deadline', () => {
  it('validates Off or 5–60 whole seconds and restricts configuration to the controlling host in the lobby', () => {
    for (const answerLimitSeconds of [-1, 1, 4, 5.5, 61])
      expect(commandSchema.safeParse({ type: 'configure', answerLimitSeconds }).success).toBe(
        false,
      );
    for (const answerLimitSeconds of [0, 5, 10, 60])
      expect(commandSchema.safeParse({ type: 'configure', answerLimitSeconds }).success).toBe(true);
    expect(() => act(lobby(), { type: 'configure', answerLimitSeconds: 10 }, A)).toThrow(
      'Only the host',
    );
    expect(() => act(question(), { type: 'configure', answerLimitSeconds: 10 })).toThrow();
  });
  it('leaves existing sessions and Off unlimited', () => {
    let s = answering(0);
    delete s.answerLimitSeconds;
    s.hostSeen = NOW + 100000;
    reconcile(s, NOW + 100000);
    expect(s.phase).toBe('answering');
    expect(s.answerDeadline).toBeUndefined();
    expect(s.players[0].score).toBe(0);
  });
  it('starts the answer timer on buzz and preserves the separate buzzer time', () => {
    const s = answering(10);
    expect(s.answerDeadline).toBe(NOW + 11000);
    expect(s.remaining).toBe(29000);
    expect(s.deadline).toBeUndefined();
  });
  it('deducts once at expiry and reopens remaining buzzer time at the exact expiry instant', () => {
    const s = answering(10);
    const old = s.windowId;
    reconcile(s, NOW + 12000);
    expect(s.players[0].score).toBe(-200);
    expect(s.phase).toBe('question');
    expect(s.deadline).toBe(NOW + 40000);
    expect(s.windowId).not.toBe(old);
    expect(s.attempted).toContain(A);
    expect(s.events[0].reason).toBe('Answer time expired');
    reconcile(s, NOW + 13000);
    expect(s.events).toHaveLength(1);
    expect(() => act(s, { type: 'buzz', windowId: s.windowId! }, A, NOW + 13000)).toThrow(
      'already answered',
    );
  });
  it('awards a timely answer and cancels the answer timer', () => {
    let s = answering(10);
    s = act(s, { type: 'judge', correct: true }, HOST, NOW + 5000);
    expect(s.players[0].score).toBe(200);
    expect(s.answerDeadline).toBeUndefined();
    reconcile(s, NOW + 12000);
    expect(s.events).toHaveLength(1);
  });
  it('rejects a correct judgment arriving at the expired deadline', () => {
    const s = answering(10);
    expect(() => act(s, { type: 'judge', correct: true }, HOST, NOW + 11000)).toThrow();
  });
  it('pauses and resumes the answer timer without consuming buzzer time', () => {
    let s = answering(10);
    s = act(s, { type: 'pause' }, HOST, NOW + 4000);
    expect(s.answerRemaining).toBe(7000);
    expect(s.remaining).toBe(29000);
    s = act(s, { type: 'continue' }, HOST, NOW + 20000);
    expect(s.answerDeadline).toBe(NOW + 27000);
    expect(s.remaining).toBe(29000);
  });
  it('restores an unexpired answer timer after the host returns days later', () => {
    const s = answering(30);
    const restored = JSON.parse(JSON.stringify(s)) as Session;
    reconcile(restored, NOW + 86400000);
    expect(restored.phase).toBe('answering');
    expect(restored.answerRemaining).toBe(16000);
    expect(restored.players[0].score).toBe(0);
    let next = act(
      restored,
      { type: 'claim', pin: '123456', controller: CTRL },
      HOST,
      NOW + 86400000,
      { pinVerified: true },
    );
    next = act(next, { type: 'continue' }, HOST, NOW + 86400000);
    expect(next.answerDeadline).toBe(NOW + 86400000 + 16000);
  });
  it('resolves an answer expiry before the disconnect pause boundary', () => {
    const s = answering(10);
    reconcile(s, NOW + 86400000);
    expect(s.phase).toBe('question');
    expect(s.paused).toBe(true);
    expect(s.remaining).toBe(25000);
    expect(s.players[0].score).toBe(-200);
  });
  it('reveals after the final eligible player times out', () => {
    let s = answering(5);
    s.players = s.players.filter((p) => p.id === A);
    reconcile(s, NOW + 6000);
    expect(s.phase).toBe('reveal');
    expect(s.players[0].score).toBe(-200);
  });
  it('resolves both answer expiry and resumed buzzer expiry when reconciliation is delayed', () => {
    let s = question(5);
    s.hostSeen = NOW + 28000;
    s = act(s, { type: 'buzz', windowId: s.windowId! }, A, NOW + 28000);
    reconcile(s, NOW + 36000);
    expect(s.phase).toBe('reveal');
    expect(s.players[0].score).toBe(-200);
  });
  it('allows correction of a timeout and returns judgment to the host without an immediate repeat timeout', () => {
    let s = answering(5);
    s = act(s, { type: 'tick' }, HOST, NOW + 6000);
    s = act(s, { type: 'undo' }, HOST, NOW + 6000);
    expect(s.phase).toBe('answering');
    expect(s.players[0].score).toBe(0);
    expect(s.answerDeadline).toBeUndefined();
    expect(s.lastTimeout).toBeUndefined();
    s = act(s, { type: 'judge', correct: true }, HOST, NOW + 6000);
    expect(s.players[0].score).toBe(200);
  });
  it('does not enable a buzzer-answer timer for Daily Double', () => {
    let s = act(lobby(), { type: 'configure', answerLimitSeconds: 5 });
    s = act(s, { type: 'start' });
    s = act(s, { type: 'select', questionId: s.board.questions.find((q) => q.dailyDouble)!.id });
    s = act(s, { type: 'dailyWager', playerId: A, amount: 0 });
    expect(s.answerDeadline).toBeUndefined();
    expect(s.phase).toBe('dailyAnswer');
  });
});
describe('standings movement', () => {
  it('sorts by current score and reports the score change and rank gain', () => {
    const s = question();
    s.players[0].score = 1000;
    s.players[1].score = 1200;
    s.events = [
      {
        id: 'score',
        playerId: B,
        questionId: s.questionId!,
        delta: 400,
        reason: 'Correct answer',
        at: NOW,
      },
    ];
    s.phase = 'reveal';
    const rows = rankedStandings(viewSession(s, HOST, NOW, CTRL));
    expect(rows.map((r) => r.player.id)).toEqual([B, A]);
    expect(rows[0]).toMatchObject({ rank: 1, delta: 400, movement: 1 });
    expect(rows[1].movement).toBe(-1);
  });
  it('includes multiple misses and resolves ties deterministically', () => {
    const s = question();
    s.players[0].score = -200;
    s.players[1].score = -200;
    const rows = rankedStandings(viewSession(s, HOST, NOW, CTRL));
    expect(rows.map((r) => r.player.name)).toEqual(['Alex', 'Sam']);
  });
  it('excludes previous questions and uses Final score events when reviewing the finale', () => {
    const s = lobby();
    s.phase = 'finalReview';
    s.final = {
      [A]: { score: 0, text: '', wager: 0, judged: true },
      [B]: { score: 0, text: '', wager: 0, judged: true },
    };
    s.events = [
      { id: 'old', playerId: A, questionId: 'old-question', delta: 500, reason: 'old', at: NOW },
      { id: 'final', playerId: B, questionId: 'final', delta: 200, reason: 'Final', at: NOW },
    ];
    s.players[1].score = 200;
    expect(rankedStandings(viewSession(s, HOST, NOW))[0]).toMatchObject({ delta: 200 });
  });
});
