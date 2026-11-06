import { z } from 'zod';
import { boardSchema, type Board } from '@/lib/game/schema';
import { MAX_QUESTION_JSON_LENGTH } from '@/lib/game/question-json';
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const MAX_RECORD_LENGTH = 1500000;
const recoverableBoard = boardSchema.safeExtend({ title: z.string().max(100) });
const draftSchema = z
  .object({
    schema: z.literal(1),
    ownerId: z.string().uuid(),
    boardId: z.union([z.literal('new'), z.string().uuid()]),
    recordId: z.string().uuid(),
    baseVersion: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    board: z.custom<Board>(
      (value) => recoverableBoard.safeParse(value).success,
      'Invalid draft board',
    ),
    jsonText: z.string().max(MAX_QUESTION_JSON_LENGTH),
    jsonDirty: z.boolean(),
    importOpen: z.boolean(),
  })
  .strict();
export type BoardDraft = z.infer<typeof draftSchema>;
export type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
export function draftPrefix(owner: string, boardId: string) {
  return `jeopardy:board-draft:v1:${owner}:${boardId}:`;
}
function key(draft: BoardDraft) {
  return draftPrefix(draft.ownerId, draft.boardId) + draft.recordId;
}
export function listBoardDrafts(
  storage: DraftStorage,
  owner: string,
  boardId: string,
  now = Date.now(),
): BoardDraft[] {
  const found: BoardDraft[] = [];
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (k?.startsWith(draftPrefix(owner, boardId))) keys.push(k);
  }
  for (const k of keys) {
    const raw = storage.getItem(k);
    if (!raw || raw.length > MAX_RECORD_LENGTH) continue;
    try {
      const draft = draftSchema.parse(JSON.parse(raw));
      if (draft.ownerId !== owner || draft.boardId !== boardId || key(draft) !== k) continue;
      if (now - draft.updatedAt > MAX_AGE || draft.updatedAt > now + 300000) {
        storage.removeItem(k);
        continue;
      }
      found.push(draft);
    } catch {
      /* Ignore malformed data without touching other storage. */
    }
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt);
}
export function saveBoardDraft(storage: DraftStorage, value: BoardDraft): boolean {
  try {
    const draft = draftSchema.parse(value);
    const raw = JSON.stringify(draft);
    if (raw.length > MAX_RECORD_LENGTH) return false;
    storage.setItem(key(draft), raw);
    // Independent editor copies survive; retain the five most recent for this board.
    for (const old of listBoardDrafts(storage, draft.ownerId, draft.boardId).slice(5))
      storage.removeItem(key(old));
    return true;
  } catch {
    return false;
  }
}
/** Do not delete a recovery copy another tab has changed since it was offered. */
export function removeBoardDraft(storage: DraftStorage, draft: BoardDraft): boolean {
  try {
    const raw = storage.getItem(key(draft));
    if (raw && raw !== JSON.stringify(draft)) return false;
    storage.removeItem(key(draft));
    return true;
  } catch {
    return false;
  }
}
