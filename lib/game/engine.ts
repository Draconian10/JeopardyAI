import type { Board, Command } from './schema';
import { playable } from './schema';
import type { Context, Phase, Session, SessionView } from './types';
export const HOST_GRACE = 15000;
export const QUESTION_MS = 30000;
export const PRACTICE_PHASES: Phase[] = ['practiceReady', 'practiceOpen', 'practiceAnswer'];
export const TIE_PHASES: Phase[] = ['tieSetup', 'tieQuestion', 'tieAnswer', 'tieReveal'];
const HOST_ACTIONS = new Set([
  'tieClue',
  'tieJudge',
  'tieNext',
  'tieReveal',
  'claim',
  'start',
  'practiceStart',
  'practiceStop',
  'configure',
  'continue',
  'pause',
  'end',
  'lockLobby',
  'remove',
  'select',
  'judge',
  'reveal',
  'next',
  'dailyWager',
  'dailyJudge',
  'openFinal',
  'finalJudge',
  'finish',
  'undo',
]);
const UNVERSIONED = new Set(['heartbeat', 'claim', 'join', 'buzz', 'wager', 'answer', 'tick']);
export class GameError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
function requireThat(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new GameError(message, status);
}
export const activePlayers = (s: Session) => s.players.filter((p) => !p.removed);
export function finalReviewPlayer(s: Session) {
  return activePlayers(s)
    .filter((p) => !s.final[p.id]?.judged)
    .sort((a, b) => s.final[a.id].score - s.final[b.id].score || a.id.localeCompare(b.id))[0]?.id;
}
export function createSession(
  board: Board,
  gameId: string,
  hostId: string,
  joinCode: string,
  now: number,
  controller?: string,
): Session {
  playable(board);
  return {
    id: crypto.randomUUID(),
    gameId,
    hostId,
    joinCode,
    title: board.title,
    board: structuredClone(board),
    version: 0,
    actionVersion: 0,
    phase: 'lobby',
    answerLimitSeconds: 0,
    paused: false,
    locked: false,
    createdAt: now,
    updatedAt: now,
    hostSeen: now,
    controller,
    players: [],
    used: [],
    remaining: QUESTION_MS,
    attempted: [],
    final: {},
    events: [],
    history: [],
    processed: [],
  };
}
function closeQuestion(s: Session) {
  if (s.questionId && !s.used.includes(s.questionId)) s.used.push(s.questionId);
  s.phase = 'reveal';
  s.answerDeadline = undefined;
  s.answerRemaining = undefined;
  s.deadline = undefined;
  s.remaining = 0;
  s.windowId = undefined;
}
function closeTie(s: Session) {
  s.phase = 'tieReveal';
  s.tiebreaker!.rounds.at(-1)!.outcome = 'unanswered';
  s.deadline = undefined;
  s.answerDeadline = undefined;
  s.answerRemaining = undefined;
  s.windowId = undefined;
  s.remaining = 0;
}
function judgeTie(s: Session, correct: boolean, now: number, timedOut = false) {
  requireThat(s.tiebreaker && s.respondent, 'No tiebreaker player is answering.');
  const round = s.tiebreaker.rounds.at(-1)!;
  round.attempts.push({ playerId: s.respondent, correct, at: now, timedOut });
  s.answerDeadline = undefined;
  s.answerRemaining = undefined;
  if (correct) {
    round.outcome = 'correct';
    round.winnerId = s.respondent;
    s.tiebreaker.winnerId = s.respondent;
    s.phase = 'finished';
    s.deadline = undefined;
    s.windowId = undefined;
  } else {
    s.attempted.push(s.respondent);
    s.respondent = undefined;
    if (s.tiebreaker.playerIds.every((id) => s.attempted.includes(id)) || s.remaining <= 0)
      closeTie(s);
    else {
      s.phase = 'tieQuestion';
      s.deadline = now + s.remaining;
      s.windowId = crypto.randomUUID();
    }
  }
}
function expire(s: Session) {
  if (s.phase === 'tieQuestion') {
    closeTie(s);
    return;
  }
  if (s.phase === 'question') closeQuestion(s);
  else if (s.phase === 'practiceOpen') {
    s.phase = 'practiceReady';
    s.deadline = undefined;
    s.remaining = 0;
    s.windowId = undefined;
  } else if (s.phase === 'finalAnswer') {
    s.phase = 'finalReview';
    s.deadline = undefined;
    s.remaining = 0;
  }
}
/** Deterministic reconciliation also works after all browsers have been closed for days. */
export function reconcile(s: Session, now: number) {
  if (s.phase === 'ended' || s.phase === 'finished' || s.paused) return;
  const lostAt = s.hostSeen + HOST_GRACE;
  const effectiveNow = Math.min(now, lostAt);
  if (
    s.answerDeadline !== undefined &&
    s.answerDeadline <= effectiveNow &&
    ['answering', 'tieAnswer'].includes(s.phase)
  ) {
    const at = s.answerDeadline;
    const playerId = s.respondent!;
    const actionId = `timeout:${s.windowId}`;
    if (s.phase === 'tieAnswer') judgeTie(s, false, at, true);
    else
      judgeRegular(
        s,
        false,
        { userId: s.hostId, now: at, actionId, expectedVersion: s.actionVersion },
        true,
      );
    if (!s.tiebreaker) s.lastTimeout = { playerId, at };
    s.processed.push(actionId);
    s.history.push({ actionId, type: 'answerTimeout', userId: s.hostId, at, phase: s.phase });
  }
  if (s.deadline !== undefined && s.deadline <= effectiveNow) expire(s);
  if (now >= lostAt) {
    freezeClocks(s, lostAt);
    s.paused = true;
    s.pauseReason = 'Host disconnected';
  }
}
function freezeClocks(s: Session, at: number) {
  if (s.deadline !== undefined) s.remaining = Math.max(0, s.deadline - at);
  if (s.answerDeadline !== undefined) s.answerRemaining = Math.max(0, s.answerDeadline - at);
  s.deadline = undefined;
  s.answerDeadline = undefined;
}
function judgeRegular(s: Session, correct: boolean, ctx: Context, timedOut = false) {
  requireThat(s.respondent, 'No player is answering.');
  rememberJudgment(s);
  const respondent = s.respondent;
  const q = s.board.questions.find((q) => q.id === s.questionId)!;
  score(
    s,
    respondent,
    correct ? q.value : -q.value,
    timedOut ? 'Answer time expired' : correct ? 'Correct answer' : 'Incorrect answer',
    ctx,
  );
  s.answerDeadline = undefined;
  s.answerRemaining = undefined;
  if (correct) closeQuestion(s);
  else {
    s.attempted.push(respondent);
    if (activePlayers(s).every((p) => s.attempted.includes(p.id)) || s.remaining <= 0)
      closeQuestion(s);
    else openBuzz(s, ctx.now);
  }
}
function score(s: Session, id: string, delta: number, reason: string, ctx: Context) {
  const player = activePlayers(s).find((p) => p.id === id);
  requireThat(player, 'Player is no longer eligible.');
  requireThat(
    Number.isSafeInteger(player.score + delta) && Math.abs(player.score + delta) <= 100000000,
    'Score limit exceeded.',
  );
  player.score += delta;
  s.events.push({
    questionId: s.questionId ?? 'final',
    id: ctx.actionId,
    playerId: id,
    delta,
    reason,
    at: ctx.now,
  });
}
function rememberJudgment(s: Session) {
  s.undo = {
    phase: s.phase,
    respondent: s.respondent,
    attempted: [...s.attempted],
    remaining: s.remaining,
    used: [...s.used],
    eventsLength: s.events.length,
    scores: Object.fromEntries(s.players.map((p) => [p.id, p.score])),
    windowId: s.windowId,
    daily: s.daily && { ...s.daily },
  };
}
function openBuzz(s: Session, now: number) {
  s.phase = 'question';
  s.windowId = crypto.randomUUID();
  s.deadline = now + s.remaining;
  s.respondent = undefined;
}
export function applyCommand(original: Session, cmd: Command, ctx: Context): Session {
  const s = structuredClone(original);
  const host = ctx.userId === s.hostId;
  const player = s.players.find((p) => p.id === ctx.userId && !p.removed);
  requireThat(host || player || cmd.type === 'join', 'You are not a member of this game.', 403);
  if (s.processed.includes(ctx.actionId)) return s;
  const dashboardEnd = cmd.type === 'end' && ctx.dashboardEnd === true;
  if (dashboardEnd) {
    requireThat(host, 'Only the host can end this session.', 403);
    if (['ended', 'finished'].includes(s.phase)) return s;
  }
  reconcile(s, ctx.now);
  if (HOST_ACTIONS.has(cmd.type)) {
    requireThat(host, 'Only the host can do this.', 403);
    if (cmd.type !== 'claim' && !dashboardEnd)
      requireThat(
        ctx.controller && ctx.controller === s.controller,
        'This tab is read-only. Resume or take control first.',
        409,
      );
  }
  if (!UNVERSIONED.has(cmd.type) && !dashboardEnd)
    requireThat(
      ctx.expectedVersion === original.actionVersion,
      'The game changed. Review the latest state and try again.',
      409,
    );
  if (cmd.type !== 'tick' && cmd.type !== 'heartbeat' && cmd.type !== 'claim')
    requireThat(!['ended', 'finished'].includes(s.phase), 'This session has ended.');
  if (!['heartbeat', 'tick', 'claim', 'continue', 'end', 'join', 'pause'].includes(cmd.type))
    requireThat(!s.paused, 'The game is paused.');
  const phase = (...phases: Phase[]) =>
    requireThat(phases.includes(s.phase), 'That action is not available at this stage.', 409);
  switch (cmd.type) {
    case 'claim':
      requireThat(ctx.pinVerified, 'Incorrect host PIN.', 403);
      requireThat(!['ended', 'finished'].includes(s.phase), 'This session has ended.');
      if (!s.paused) {
        freezeClocks(s, ctx.now);
      }
      s.controller = cmd.controller;
      s.hostSeen = ctx.now;
      s.paused = true;
      s.pauseReason = 'Ready to resume';
      break;
    case 'heartbeat':
      if (host) {
        requireThat(ctx.controller === s.controller, 'Another tab controls this game.', 409);
        s.hostSeen = ctx.now;
      } else {
        requireThat(player, 'Player not found.', 403);
        player.lastSeen = ctx.now;
      }
      break;
    case 'tick':
      break;
    case 'continue':
      requireThat(s.paused, 'The game is already running.');
      s.paused = false;
      s.pauseReason = undefined;
      s.hostSeen = ctx.now;
      if (['question', 'finalAnswer', 'practiceOpen', 'tieQuestion'].includes(s.phase))
        s.deadline = ctx.now + s.remaining;
      if (['answering', 'tieAnswer'].includes(s.phase) && s.answerRemaining !== undefined)
        s.answerDeadline = ctx.now + s.answerRemaining;
      break;
    case 'pause':
      if (!s.paused) {
        freezeClocks(s, ctx.now);
        s.paused = true;
        s.pauseReason = 'Paused by host';
      }
      break;
    case 'end':
      s.phase = 'ended';
      s.deadline = undefined;
      s.answerDeadline = undefined;
      s.answerRemaining = undefined;
      s.paused = false;
      s.locked = true;
      break;
    case 'join': {
      requireThat(ctx.userId !== s.hostId, 'Use a separate device or browser profile to play.');
      const prior = s.players.find((p) => p.id === ctx.userId);
      if (prior) {
        requireThat(!prior.removed, 'You were removed from this session.', 403);
        prior.lastSeen = ctx.now;
        break;
      }
      phase('lobby', ...PRACTICE_PHASES);
      requireThat(!s.locked, 'The lobby is locked.');
      requireThat(s.players.length < 50, 'This session is full.');
      requireThat(
        !s.players.some(
          (p) =>
            !p.removed && p.name.toLocaleLowerCase('en-US') === cmd.name.toLocaleLowerCase('en-US'),
        ),
        'That name is already taken.',
      );
      s.players.push({
        id: ctx.userId,
        name: cmd.name,
        score: 0,
        lastSeen: ctx.now,
        removed: false,
      });
      break;
    }
    case 'lockLobby':
      phase('lobby', ...PRACTICE_PHASES);
      s.locked = cmd.locked;
      break;
    case 'remove': {
      phase('lobby', ...PRACTICE_PHASES);
      const removed = s.players.find((p) => p.id === cmd.playerId);
      requireThat(removed, 'Player not found.');
      removed.removed = true;
      break;
    }
    case 'configure':
      phase('lobby');
      s.answerLimitSeconds = cmd.answerLimitSeconds;
      break;
    case 'practiceStart':
      phase('lobby', ...PRACTICE_PHASES);
      requireThat(activePlayers(s).length > 0, 'At least one player must join.');
      s.phase = 'practiceOpen';
      s.remaining = QUESTION_MS;
      s.deadline = ctx.now + QUESTION_MS;
      s.windowId = crypto.randomUUID();
      s.respondent = undefined;
      s.attempted = [];
      s.undo = undefined;
      break;
    case 'practiceStop':
      phase(...PRACTICE_PHASES);
      s.phase = 'lobby';
      s.deadline = undefined;
      s.windowId = undefined;
      s.respondent = undefined;
      s.attempted = [];
      s.remaining = QUESTION_MS;
      break;
    case 'start':
      phase('lobby');
      requireThat(activePlayers(s).length > 0, 'At least one player must join.');
      s.phase = 'board';
      s.locked = true;
      break;
    case 'select': {
      phase('board');
      const q = s.board.questions.find((q) => q.id === cmd.questionId);
      requireThat(q && !s.used.includes(q.id), 'Choose an unused question.');
      s.questionId = q.id;
      s.questionOpenedAt = ctx.now;
      s.attempted = [];
      s.respondent = undefined;
      s.daily = undefined;
      s.undo = undefined;
      s.remaining = QUESTION_MS;
      s.lastTimeout = undefined;
      s.answerDeadline = undefined;
      s.answerRemaining = undefined;
      if (q.dailyDouble) {
        s.phase = 'dailyWager';
        s.deadline = undefined;
        s.windowId = undefined;
      } else openBuzz(s, ctx.now);
      break;
    }
    case 'buzz':
      phase('question', 'practiceOpen', 'tieQuestion');
      if (s.phase === 'tieQuestion')
        requireThat(
          s.tiebreaker?.playerIds.includes(ctx.userId),
          'Only tied leaders can buzz.',
          403,
        );
      requireThat(player, 'Player not found.', 403);
      requireThat(cmd.windowId === s.windowId, 'That buzzer window has closed.', 409);
      requireThat(!s.attempted.includes(player.id), 'You already answered this question.');
      requireThat(s.deadline !== undefined && ctx.now < s.deadline, 'Time has expired.');
      s.remaining = s.deadline - ctx.now;
      s.deadline = undefined;
      s.respondent = player.id;
      if (s.phase === 'practiceOpen') {
        s.phase = 'practiceAnswer';
      } else {
        s.phase = s.phase === 'tieQuestion' ? 'tieAnswer' : 'answering';
        if ((s.answerLimitSeconds ?? 0) > 0) {
          s.answerRemaining = s.answerLimitSeconds! * 1000;
          s.answerDeadline = ctx.now + s.answerRemaining;
        }
      }
      break;
    case 'judge': {
      phase('answering');
      judgeRegular(s, cmd.correct, ctx);
      break;
    }
    case 'reveal':
      phase('question', 'answering', 'dailyWager', 'dailyAnswer');
      s.undo = undefined;
      closeQuestion(s);
      break;
    case 'next':
      phase('reveal');
      s.lastTimeout = undefined;
      s.undo = undefined;
      s.questionId = undefined;
      s.respondent = undefined;
      s.daily = undefined;
      s.attempted = [];
      if (s.used.length === s.board.questions.length) {
        s.phase = 'finalWager';
        s.questionOpenedAt = ctx.now;
        s.final = Object.fromEntries(
          activePlayers(s).map((p) => [p.id, { score: p.score, text: '' }]),
        );
      } else s.phase = 'board';
      break;
    case 'dailyWager': {
      phase('dailyWager');
      const p = activePlayers(s).find((p) => p.id === cmd.playerId);
      requireThat(p, 'Choose a player.');
      requireThat(cmd.amount <= Math.abs(p.score), 'Wager exceeds the absolute player score.');
      s.daily = { playerId: p.id, amount: cmd.amount };
      s.phase = 'dailyAnswer';
      break;
    }
    case 'dailyJudge':
      phase('dailyAnswer');
      requireThat(s.daily, 'Set a wager first.');
      rememberJudgment(s);
      score(
        s,
        s.daily.playerId,
        cmd.correct ? s.daily.amount : -s.daily.amount,
        'Daily Double',
        ctx,
      );
      closeQuestion(s);
      break;
    case 'wager':
      phase('finalWager');
      requireThat(player, 'Player not found.', 403);
      requireThat(
        cmd.amount <= Math.abs(s.final[player.id].score),
        'Wager exceeds your absolute pre-Final score.',
      );
      s.final[player.id].wager = cmd.amount;
      break;
    case 'openFinal':
      phase('finalWager');
      for (const entry of Object.values(s.final)) entry.wager ??= 0;
      s.phase = 'finalAnswer';
      s.remaining = QUESTION_MS;
      s.deadline = ctx.now + QUESTION_MS;
      break;
    case 'answer':
      phase('finalAnswer');
      requireThat(player, 'Player not found.', 403);
      requireThat(s.deadline !== undefined && ctx.now < s.deadline, 'Answers are locked.');
      s.final[player.id].text = cmd.text;
      break;
    case 'finalJudge': {
      phase('finalReview');
      requireThat(cmd.playerId === finalReviewPlayer(s), 'Review the next player in order.');
      const entry = s.final[cmd.playerId];
      requireThat(entry && !entry.judged, 'This answer was already judged.');
      requireThat(!cmd.correct || !!entry.text.trim(), 'A blank answer must be marked incorrect.');
      score(s, cmd.playerId, cmd.correct ? entry.wager! : -entry.wager!, 'Final Jeopardy', ctx);
      entry.judged = true;
      entry.correct = cmd.correct;
      break;
    }
    case 'finish':
      phase('finalReview');
      requireThat(!finalReviewPlayer(s), 'Judge every answer first.');
      {
        const players = activePlayers(s);
        const high = Math.max(...players.map((p) => p.score));
        const leaders = players.filter((p) => p.score === high);
        if (leaders.length > 1) {
          s.tiebreaker = { playerIds: leaders.map((p) => p.id), rounds: [] };
          s.phase = 'tieSetup';
          s.questionId = undefined;
          s.respondent = undefined;
          s.windowId = undefined;
          s.deadline = undefined;
          s.lastTimeout = undefined;
          s.undo = undefined;
        } else s.phase = 'finished';
      }
      break;
    case 'tieClue':
      phase('tieSetup');
      requireThat(s.tiebreaker && !s.tiebreaker.winnerId, 'No tiebreaker is pending.');
      s.tiebreaker.rounds.push({
        id: crypto.randomUUID(),
        category: cmd.category,
        prompt: cmd.prompt,
        answer: cmd.answer,
        attempts: [],
      });
      s.attempted = [];
      s.respondent = undefined;
      s.remaining = QUESTION_MS;
      s.deadline = ctx.now + QUESTION_MS;
      s.answerDeadline = undefined;
      s.answerRemaining = undefined;
      s.windowId = crypto.randomUUID();
      s.phase = 'tieQuestion';
      break;
    case 'tieJudge':
      phase('tieAnswer');
      judgeTie(s, cmd.correct, ctx.now);
      break;
    case 'tieReveal':
      phase('tieQuestion', 'tieAnswer');
      closeTie(s);
      break;
    case 'tieNext':
      phase('tieReveal');
      s.phase = 'tieSetup';
      s.respondent = undefined;
      s.attempted = [];
      break;
    case 'undo': {
      requireThat(
        s.undo && ['question', 'reveal'].includes(s.phase),
        'There is no judgment to correct.',
      );
      const u = s.undo;
      for (const p of s.players) p.score = u.scores[p.id] ?? p.score;
      s.events = s.events.slice(0, u.eventsLength);
      s.phase = u.phase;
      s.respondent = u.respondent;
      s.attempted = u.attempted;
      s.remaining = u.remaining;
      s.used = u.used;
      s.daily = u.daily;
      s.windowId = u.windowId;
      s.deadline = undefined;
      s.answerDeadline = undefined;
      s.answerRemaining = undefined;
      s.undo = undefined;
      s.lastTimeout = undefined;
      break;
    }
  }
  // A correction is allowed only before another player successfully buzzes.
  if (cmd.type === 'buzz') s.undo = undefined;
  if (!['heartbeat', 'tick'].includes(cmd.type)) {
    s.processed.push(ctx.actionId);
    s.history.push({
      actionId: ctx.actionId,
      type: cmd.type,
      userId: ctx.userId,
      at: ctx.now,
      phase: s.phase,
    });
  }
  if (
    !['heartbeat', 'tick'].includes(cmd.type) ||
    s.phase !== original.phase ||
    s.paused !== original.paused
  )
    s.actionVersion++;
  s.updatedAt = ctx.now;
  s.version = original.version + 1;
  return s;
}
export function viewSession(
  s: Session,
  userId: string,
  now: number,
  controller?: string,
  audience = false,
): SessionView {
  const host = userId === s.hostId;
  const me = activePlayers(s).find((p) => p.id === userId);
  requireThat(host || me, 'You do not have access to this session.', 403);
  const privateHost = host && !audience;
  const q = s.board.questions.find((q) => q.id === s.questionId);
  const revealed = s.phase === 'reveal';
  const finalDone = s.phase === 'finished';
  const currentReview = s.phase === 'finalReview' ? finalReviewPlayer(s) : undefined;
  const entries: SessionView['finalEntries'] = {};
  for (const [id, entry] of Object.entries(s.final)) {
    const visible = privateHost || id === me?.id || entry.judged || finalDone;
    entries[id] = visible ? { ...entry } : { score: entry.score, judged: entry.judged };
    // Submission status without exposing the private wager or answer.
    if (!visible) {
      entries[id].wager = entry.wager === undefined ? undefined : 0;
    }
  }
  return {
    id: s.id,
    gameId: s.gameId,
    title: s.title,
    joinCode: s.joinCode,
    version: s.version,
    actionVersion: s.actionVersion,
    phase: s.phase,
    paused: s.paused,
    pauseReason: s.pauseReason,
    locked: s.locked,
    createdAt: s.createdAt,
    serverNow: now,
    hostConnected: now - s.hostSeen < HOST_GRACE,
    controllerOwned: host && controller === s.controller,
    players: activePlayers(s),
    categories: s.board.categories,
    rows: s.board.rows,
    tiles: s.board.questions.map((q) => ({
      id: q.id,
      category: q.category,
      row: q.row,
      value: q.value,
      used: s.used.includes(q.id),
    })),
    question: q
      ? {
          id: q.id,
          category: s.board.categories[q.category],
          value: q.value,
          prompt:
            s.phase === 'dailyWager' ? 'Daily Double' : s.phase === 'answering' ? '' : q.prompt,
          answer: revealed || privateHost ? q.answer : undefined,
          notes: privateHost ? q.notes : undefined,
        }
      : undefined,
    finalCategory: ['finalWager', 'finalAnswer', 'finalReview', 'finished'].includes(s.phase)
      ? s.board.final.category
      : undefined,
    finalPrompt: ['finalAnswer', 'finalReview', 'finished'].includes(s.phase)
      ? s.board.final.prompt
      : undefined,
    finalAnswer: privateHost || finalDone ? s.board.final.answer : undefined,
    finalEntries: entries,
    finalReviewPlayer: currentReview,
    remaining: s.remaining,
    questionOpenedAt: s.questionOpenedAt,
    deadline: s.deadline,
    answerLimitSeconds: s.answerLimitSeconds ?? 0,
    answerDeadline: s.answerDeadline,
    answerRemaining: s.answerRemaining,
    lastTimeout: s.lastTimeout,
    windowId: s.windowId,
    respondent: s.respondent,
    attempted: s.attempted,
    daily: s.daily,
    events: s.events,
    tiebreaker: s.tiebreaker
      ? {
          playerIds: s.tiebreaker.playerIds,
          winnerId: s.tiebreaker.winnerId,
          roundNumber: s.tiebreaker.rounds.length + (s.phase === 'tieSetup' ? 1 : 0),
          round:
            s.tiebreaker.rounds.length && s.phase !== 'tieSetup'
              ? (() => {
                  const round = s.tiebreaker!.rounds.at(-1)!;
                  return {
                    ...round,
                    prompt: s.phase === 'tieAnswer' ? '' : round.prompt,
                    answer:
                      privateHost || s.phase === 'tieReveal' || finalDone
                        ? round.answer
                        : undefined,
                  };
                })()
              : undefined,
        }
      : undefined,
    canUndo: privateHost && !!s.undo,
  };
}
