import type { SessionView } from './types';
export function rankedStandings(
  s: Pick<SessionView, 'players' | 'events' | 'question' | 'phase' | 'tiebreaker'>,
) {
  const questionId =
    s.question?.id ?? (['finalReview', 'finished'].includes(s.phase) ? 'final' : undefined);
  const events = questionId ? s.events.filter((e) => e.questionId === questionId) : [];
  const delta = new Map(
    s.players.map((p) => [
      p.id,
      events.filter((e) => e.playerId === p.id).reduce((sum, e) => sum + e.delta, 0),
    ]),
  );
  const sorted = [...s.players].sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.id === s.tiebreaker?.winnerId) - Number(a.id === s.tiebreaker?.winnerId) ||
      a.name.localeCompare(b.name),
  );
  const prior = [...s.players].sort(
    (a, b) =>
      b.score - (delta.get(b.id) ?? 0) - (a.score - (delta.get(a.id) ?? 0)) ||
      a.name.localeCompare(b.name),
  );
  return sorted.map((player, index) => ({
    player,
    rank: index + 1,
    delta: delta.get(player.id) ?? 0,
    movement: prior.findIndex((p) => p.id === player.id) - index,
  }));
}
