import { describe, expect, it } from 'vitest';
import {
  draftPrefix,
  listBoardDrafts,
  removeBoardDraft,
  saveBoardDraft,
  type BoardDraft,
  type DraftStorage,
} from '@/lib/board-drafts';
import { blankBoard } from '@/lib/game/starter';
function storage(): DraftStorage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}
const owner = crypto.randomUUID();
function copy(patch: Partial<BoardDraft> = {}): BoardDraft {
  return {
    schema: 1,
    ownerId: owner,
    boardId: 'new',
    recordId: crypto.randomUUID(),
    baseVersion: 0,
    updatedAt: Date.now(),
    board: blankBoard(),
    jsonText: '{incomplete',
    jsonDirty: true,
    importOpen: true,
    ...patch,
  };
}
describe('private local board recovery', () => {
  it('retains incomplete boards and unapplied JSON, isolated by owner and board', () => {
    const s = storage(),
      d = copy();
    expect(saveBoardDraft(s, d)).toBe(true);
    expect(listBoardDrafts(s, owner, 'new')).toEqual([d]);
    expect(listBoardDrafts(s, crypto.randomUUID(), 'new')).toEqual([]);
    expect(listBoardDrafts(s, owner, crypto.randomUUID())).toEqual([]);
  });
  it('rejects extra fields including PINs and invalid board structures', () => {
    const s = storage();
    expect(saveBoardDraft(s, { ...copy(), pin: '123456' } as BoardDraft)).toBe(false);
    const d = copy();
    d.board.questions = [];
    expect(saveBoardDraft(s, d)).toBe(false);
    expect(s.length).toBe(0);
  });
  it('ignores corrupt, mismatched and expired copies without reading other keys', () => {
    const s = storage();
    s.setItem('unrelated', 'keep');
    const d = copy({ updatedAt: Date.now() - 8 * 86400000 });
    s.setItem(draftPrefix(owner, 'new') + d.recordId, JSON.stringify(d));
    s.setItem(draftPrefix(owner, 'new') + 'bad', '{bad');
    expect(listBoardDrafts(s, owner, 'new')).toEqual([]);
    expect(s.getItem('unrelated')).toBe('keep');
  });
  it('keeps independent editor copies and retains only the newest five', () => {
    const s = storage();
    for (let i = 0; i < 7; i++)
      expect(saveBoardDraft(s, copy({ updatedAt: Date.now() + i }))).toBe(true);
    expect(listBoardDrafts(s, owner, 'new')).toHaveLength(5);
  });
  it('does not delete a copy updated in another tab', () => {
    const s = storage(),
      d = copy();
    saveBoardDraft(s, d);
    saveBoardDraft(s, { ...d, updatedAt: d.updatedAt + 1, jsonText: 'newer' });
    expect(removeBoardDraft(s, d)).toBe(false);
    expect(listBoardDrafts(s, owner, 'new')[0].jsonText).toBe('newer');
  });
  it('reports blocked or full storage without breaking editing', () => {
    const s = storage();
    s.setItem = () => {
      throw new Error('Quota');
    };
    expect(saveBoardDraft(s, copy())).toBe(false);
  });
  it('clears only the saved/discarded copy', () => {
    const s = storage(),
      a = copy(),
      b = copy();
    saveBoardDraft(s, a);
    saveBoardDraft(s, b);
    expect(removeBoardDraft(s, a)).toBe(true);
    expect(listBoardDrafts(s, owner, 'new')).toEqual([b]);
  });
});

it('recovers an empty title and preserves partially typed whitespace', () => {
  const s = storage(),
    d = copy();
  d.board.title = '';
  d.board.questions[0].prompt = '  unfinished clue ';
  expect(saveBoardDraft(s, d)).toBe(true);
  expect(listBoardDrafts(s, owner, 'new')[0].board).toEqual(d.board);
});
