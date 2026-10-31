import { db } from './db';
import { applyCommand, GameError, reconcile } from '@/lib/game/engine';
import type { Command } from '@/lib/game/schema';
import type { Context, Session } from '@/lib/game/types';
export interface SessionRow {
  id: string;
  state: Session;
  pin_hash: string;
  version: number;
}
export async function readSession(id: string): Promise<SessionRow> {
  const { data, error } = await db()
    .from('sessions')
    .select('id,state,pin_hash,version')
    .eq('id', id)
    .single();
  if (error || !data) throw new GameError('Session not found.', 404);
  return data as SessionRow;
}
function authorize(s: Session, userId: string) {
  if (s.hostId !== userId && !s.players.some((p) => p.id === userId && !p.removed))
    throw new GameError('You do not have access to this session.', 403);
}
async function commit(before: Session, after: Session) {
  const { data, error } = await db().rpc('commit_session', {
    p_id: before.id,
    p_expected: before.version,
    p_state: after,
  });
  if (error) {
    console.error('Session commit failed', error.code);
    throw new GameError('Could not save your action. Please retry.', 503);
  }
  return data as boolean;
}
export async function loadSession(id: string, userId: string) {
  for (let i = 0; i < 12; i++) {
    const row = await readSession(id);
    authorize(row.state, userId);
    const next = structuredClone(row.state);
    reconcile(next, Date.now());
    if (JSON.stringify(next) === JSON.stringify(row.state)) return row;
    next.version++;
    next.actionVersion++;
    next.updatedAt = Date.now();
    if (await commit(row.state, next)) return { ...row, state: next, version: next.version };
  }
  throw new GameError('Game is busy. Retry in a moment.', 409);
}
export async function mutate(id: string, command: Command, context: Context) {
  for (let i = 0; i < 20; i++) {
    const row = await readSession(id);
    const next = applyCommand(row.state, command, { ...context, now: Date.now() });
    if (next.version === row.version) return row.state;
    if (await commit(row.state, next)) return next;
    // Safe actions retry against fresh persisted state. Host judgments retain their
    // original expected version and will reject instead of judging another attempt.
  }
  throw new GameError('Game is busy. Please try again.', 409);
}
