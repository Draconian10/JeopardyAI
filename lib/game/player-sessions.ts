import type { Phase, Session } from './types';

export interface PlayerSessionSummary {
  id: string;
  title: string;
  playerName: string;
  score: number;
  phase: Phase;
  paused: boolean;
}

/** A deliberately small projection: no board, answers, wagers, PINs or other players. */
export function playerSessionSummary(s: Session, userId: string): PlayerSessionSummary | null {
  if (s.hostId === userId || s.phase === 'finished' || s.phase === 'ended') return null;
  const player = s.players.find((p) => p.id === userId && !p.removed);
  if (!player) return null;
  return {
    id: s.id,
    title: s.title,
    playerName: player.name,
    score: player.score,
    phase: s.phase,
    paused: s.paused,
  };
}
