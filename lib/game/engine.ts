import type { Board, Command } from './schema';
import { playable } from './schema';
import type { Context, Phase, Session, SessionView } from './types';
export const HOST_GRACE = 15000;
export const QUESTION_MS = 30000;
const HOST_ACTIONS = new Set([
  'claim',
  'start',
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
    paused: false,
    locked: false,
    createdAt: now,
    updatedAt: now,
    hostSeen: now,
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
  s.deadline = undefined;
  s.remaining = 0;
  s.windowId = undefined;
}
function expire(s: Session) {
  if (s.phase === 'question') closeQuestion(s);
  else if (s.phase === 'finalAnswer') {
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
  if (s.deadline !== undefined && s.deadline <= effectiveNow) expire(s);
  if (now >= lostAt) {
    s.remaining = s.deadline !== undefined ? Math.max(0, s.deadline - lostAt) : s.remaining;
    s.deadline = undefined;
    s.paused = true;
    s.pauseReason = 'Host disconnected';
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
  reconcile(s, ctx.now);
  if (HOST_ACTIONS.has(cmd.type)) {
    requireThat(host, 'Only the host can do this.', 403);
    if (cmd.type !== 'claim')
      requireThat(
        ctx.controller && ctx.controller === s.controller,
        'This tab is read-only. Resume or take control first.',
        409,
      );
  }
  if (!UNVERSIONED.has(cmd.type))
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
        s.remaining = s.deadline !== undefined ? Math.max(0, s.deadline - ctx.now) : s.remaining;
        s.deadline = undefined;
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
      if (s.phase === 'question' || s.phase === 'finalAnswer') s.deadline = ctx.now + s.remaining;
      break;
    case 'pause':
      if (!s.paused) {
        s.remaining = s.deadline !== undefined ? Math.max(0, s.deadline - ctx.now) : s.remaining;
        s.deadline = undefined;
        s.paused = true;
        s.pauseReason = 'Paused by host';
      }
      break;
    case 'end':
      s.phase = 'ended';
      s.deadline = undefined;
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
      phase('lobby');
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
      phase('lobby');
      s.locked = cmd.locked;
      break;
    case 'remove': {
      phase('lobby');
      const removed = s.players.find((p) => p.id === cmd.playerId);
      requireThat(removed, 'Player not found.');
      removed.removed = true;
      break;
    }
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
      if (q.dailyDouble) {
        s.phase = 'dailyWager';
        s.deadline = undefined;
        s.windowId = undefined;
      } else openBuzz(s, ctx.now);
      break;
    }
    case 'buzz':
      phase('question');
      requireThat(player, 'Player not found.', 403);
      requireThat(cmd.windowId === s.windowId, 'That buzzer window has closed.', 409);
      requireThat(!s.attempted.includes(player.id), 'You already answered this question.');
      requireThat(s.deadline !== undefined && ctx.now < s.deadline, 'Time has expired.');
      s.remaining = s.deadline - ctx.now;
      s.deadline = undefined;
      s.respondent = player.id;
      s.phase = 'answering';
      break;
    case 'judge': {
      phase('answering');
      requireThat(s.respondent, 'No player is answering.');
      rememberJudgment(s);
      const q = s.board.questions.find((q) => q.id === s.questionId)!;
      score(
        s,
        s.respondent,
        cmd.correct ? q.value : -q.value,
        cmd.correct ? 'Correct answer' : 'Incorrect answer',
        ctx,
      );
      if (cmd.correct) closeQuestion(s);
      else {
        s.attempted.push(s.respondent);
        if (activePlayers(s).every((p) => s.attempted.includes(p.id)) || s.remaining <= 0)
          closeQuestion(s);
        else openBuzz(s, ctx.now);
      }
      break;
    }
    case 'reveal':
      phase('question', 'answering', 'dailyWager', 'dailyAnswer');
      s.undo = undefined;
      closeQuestion(s);
      break;
    case 'next':
      phase('reveal');
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
      s.phase = 'finished';
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
      s.undo = undefined;
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
          prompt: s.phase === 'dailyWager' ? 'Daily Double' : q.prompt,
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
    windowId: s.windowId,
    respondent: s.respondent,
    attempted: s.attempted,
    daily: s.daily,
    events: s.events,
    canUndo: privateHost && !!s.undo,
  };
}
