import type { Session } from './types';

/** Quote every cell; neutralize spreadsheet formulas only in text, preserving numeric scores. */
function cell(value: string | number) {
  const text =
    typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@]/u.test(value)
      ? `'${value}`
      : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}
export function resultsCsv(s: Session): string {
  const header = [
    'Record type',
    'Session ID',
    'Game',
    'Join code',
    'Session status',
    'Rank',
    'Player ID',
    'Player',
    'Removed',
    'Question number',
    'Question ID',
    'Category',
    'Question',
    'Tile value',
    'Score change',
    'Score after',
    'Detail',
    'Timestamp UTC',
  ];
  const rows: (string | number)[][] = [header];
  const row = (
    type: string,
    playerId: string,
    rank: string | number,
    question: (string | number)[],
    delta: string | number,
    after: number,
    detail: string,
    at = '',
  ) => {
    const p = s.players.find((p) => p.id === playerId)!;
    rows.push([
      type,
      s.id,
      s.title,
      s.joinCode,
      s.phase === 'finished' ? 'Completed' : 'Ended early',
      rank,
      p.id,
      p.name,
      p.removed ? 'Yes' : 'No',
      ...question,
      delta,
      after,
      detail,
      at,
    ]);
  };
  const active = s.players
    .filter((p) => !p.removed)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.id === s.tiebreaker?.winnerId) - Number(a.id === s.tiebreaker?.winnerId) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
  for (const p of [...active, ...s.players.filter((p) => p.removed)]) {
    const rank = p.removed
      ? ''
      : s.tiebreaker?.winnerId && p.id === s.tiebreaker.winnerId
        ? 1
        : active.findIndex(
            (other) =>
              other.score === p.score &&
              (!s.tiebreaker?.winnerId || other.id !== s.tiebreaker.winnerId),
          ) + 1;
    row(
      'Final standing',
      p.id,
      rank,
      ['', '', '', '', ''],
      '',
      p.score,
      p.removed
        ? 'Removed; excluded from ranking'
        : p.id === s.tiebreaker?.winnerId
          ? 'Won sudden-death tiebreaker'
          : '',
    );
  }
  // Recover the baseline rather than assuming zero, for compatibility with older saved sessions.
  const running = new Map(
    s.players.map((p) => [
      p.id,
      p.score - s.events.filter((e) => e.playerId === p.id).reduce((sum, e) => sum + e.delta, 0),
    ]),
  );
  const questionIds = [
    ...new Set([
      ...s.used,
      ...(s.questionId ? [s.questionId] : []),
      ...s.events.filter((e) => e.questionId !== 'final').map((e) => e.questionId),
      ...(s.history.some(
        (h) => h.type === 'openFinal' || h.phase === 'finalAnswer' || h.phase === 'finalReview',
      ) ||
      s.phase === 'finished' ||
      s.events.some((e) => e.questionId === 'final')
        ? ['final']
        : []),
    ]),
  ];
  questionIds.forEach((id, index) => {
    const q = s.board.questions.find((q) => q.id === id);
    const question = [
      index + 1,
      id,
      id === 'final' ? s.board.final.category : q ? s.board.categories[q.category] : '',
      id === 'final' ? s.board.final.prompt : (q?.prompt ?? ''),
      q?.value ?? '',
    ];
    const events = s.events.filter((e) => e.questionId === id);
    for (const e of events) {
      if (!running.has(e.playerId)) continue;
      const after = running.get(e.playerId)! + e.delta;
      running.set(e.playerId, after);
      row(
        'Score event',
        e.playerId,
        '',
        question,
        e.delta,
        after,
        e.reason,
        new Date(e.at).toISOString(),
      );
    }
    for (const p of s.players) {
      const own = events.filter((e) => e.playerId === p.id);
      row(
        'Question summary',
        p.id,
        '',
        question,
        own.reduce((sum, e) => sum + e.delta, 0),
        running.get(p.id)!,
        own.length ? own.map((e) => e.reason).join('; ') : 'No score change',
      );
    }
  });
  for (const [index, round] of (s.tiebreaker?.rounds ?? []).entries()) {
    const question = [`T${index + 1}`, round.id, round.category, round.prompt, ''];
    for (const attempt of round.attempts) {
      const p = s.players.find((p) => p.id === attempt.playerId);
      if (p)
        row(
          'Tiebreaker response',
          p.id,
          '',
          question,
          0,
          p.score,
          attempt.correct
            ? 'Correct; tiebreaker winner'
            : attempt.timedOut
              ? 'Answer time expired; no points deducted'
              : 'Incorrect; no points deducted',
          new Date(attempt.at).toISOString(),
        );
    }
    if (!round.winnerId)
      for (const id of s.tiebreaker!.playerIds) {
        const p = s.players.find((p) => p.id === id);
        if (p) row('Tiebreaker summary', id, '', question, 0, p.score, 'No winner on this clue');
      }
  }
  // UTF-8 BOM makes names readable when opening directly in Excel.
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
