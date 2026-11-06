import { db } from './db';
import { applyCommand, GameError, reconcile } from '@/lib/game/engine';
import type { Command } from '@/lib/game/schema';
import type { AnswerReceipt, Context, HeartbeatReceipt, Session } from '@/lib/game/types';
export interface SessionRow {
  id: string;
  state: Session;
  pin_hash: string;
  version: number;
  runtimeAt?: number;
}
function rpcError(error: { code?: string } | null) {
  if (!error) return;
  console.error('Session runtime RPC failed', error.code);
  throw new GameError(
    error.code === 'PGRST202' || error.code === '42883'
      ? 'Apply Supabase migration 004_scalable_runtime.sql before using this version.'
      : 'Could not save or load the game. Please retry.',
    503,
  );
}
export async function readSession(id: string): Promise<SessionRow> {
  const { data, error } = await db().rpc('read_session_runtime', { p_id: id });
  rpcError(error);
  if (!data) throw new GameError('Session not found.', 404);
  return data as SessionRow;
}
function authorize(s: Session, userId: string) {
  if (s.hostId !== userId && !s.players.some((p) => p.id === userId && !p.removed))
    throw new GameError('You do not have access to this session.', 403);
}
async function commit(
  before: Session,
  after: Session,
  buzz?: { windowId: string; userId: string },
) {
  const { data, error } = await db().rpc(buzz ? 'claim_session_buzz' : 'commit_session', {
    p_id: before.id,
    p_expected: before.version,
    p_state: after,
    ...(buzz ? { p_window: buzz.windowId, p_user: buzz.userId } : {}),
  });
  rpcError(error);
  return data as boolean;
}
export async function heartbeat(id: string, context: Context): Promise<HeartbeatReceipt> {
  let { data, error } = await db().rpc('touch_session_presence', {
    p_id: id,
    p_user: context.userId,
    p_controller: context.controller ?? null,
  });
  rpcError(error);
  if (data?.error) throw new GameError(data.error, data.status);
  if (data?.reconcile) {
    await loadSession(id, context.userId);
    ({ data, error } = await db().rpc('touch_session_presence', {
      p_id: id,
      p_user: context.userId,
      p_controller: context.controller ?? null,
    }));
    rpcError(error);
    if (data?.error) throw new GameError(data.error, data.status);
    return { ...data, needsRefresh: true } as HeartbeatReceipt;
  }
  return data as HeartbeatReceipt;
}
export async function saveAnswer(
  id: string,
  command: Extract<Command, { type: 'answer' }>,
  context: Context,
): Promise<AnswerReceipt> {
  const { data, error } = await db().rpc('save_final_draft', {
    p_id: id,
    p_user: context.userId,
    p_text: command.text,
    p_revision: command.revision ?? null,
    p_action: context.actionId,
  });
  rpcError(error);
  if (data?.error) throw new GameError(data.error, data.status);
  return data as AnswerReceipt;
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
    if (await commit(row.state, next)) return readSession(id);
  }
  throw new GameError('Game is busy. Retry in a moment.', 409);
}
export async function mutate(id: string, command: Command, context: Context) {
  for (let i = 0; i < 20; i++) {
    const row = await readSession(id);
    const next = applyCommand(row.state, command, { ...context, now: Date.now() });
    if (next.version === row.version) return row.state;
    if (
      await commit(
        row.state,
        next,
        command.type === 'buzz'
          ? { windowId: command.windowId, userId: context.userId }
          : undefined,
      )
    ) {
      // The database freezes the latest accepted drafts at the phase boundary.
      return (await readSession(id)).state;
    }
    if (command.type === 'buzz') throw new GameError('That buzzer window has closed.', 409);
  }
  throw new GameError('Game is busy. Please try again.', 409);
}
