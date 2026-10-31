import { describe, expect, it } from 'vitest';
import { createSession } from '@/lib/game/engine';
import { starterBoard } from '@/lib/game/starter';
import { resultsCsv } from '@/lib/game/results-csv';
function fixture() {
  const s = createSession(starterBoard(), crypto.randomUUID(), crypto.randomUUID(), '001234', 1000);
  s.phase = 'finished';
  s.players = [
    { id: 'a', name: 'Alex', score: 400, lastSeen: 1000, removed: false },
    { id: 'b', name: 'Béa, "B"\nSecond line', score: -200, lastSeen: 1000, removed: false },
    { id: 'c', name: '=HYPERLINK("bad")', score: 400, lastSeen: 1000, removed: false },
  ];
  const q1 = s.board.questions[0].id,
    q2 = s.board.questions[1].id;
  s.used = [q1, q2];
  s.events = [
    { id: '1', questionId: q1, playerId: 'b', delta: -200, reason: 'Incorrect', at: 2000 },
    { id: '2', questionId: q1, playerId: 'a', delta: 200, reason: 'Correct', at: 3000 },
    { id: '3', questionId: 'final', playerId: 'a', delta: 200, reason: 'Final Jeopardy', at: 4000 },
  ];
  return s;
}
function records(csv: string) {
  const cells = [...csv.matchAll(/"((?:[^"\uFEFF]|"")*)"(?:,|\r\n)/g)].map((m) =>
    m[1].replace(/""/g, '"'),
  );
  const header = cells.splice(0, 18);
  return Array.from({ length: cells.length / 18 }, (_, i) =>
    Object.fromEntries(header.map((key, j) => [key, cells[i * 18 + j]])),
  );
}
describe('results CSV', () => {
  it('exports consistent headers, UTF-8 names, leading-zero join codes and tied rankings', () => {
    const csv = resultsCsv(fixture());
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const standings = records(csv).filter((r) => r['Record type'] === 'Final standing');
    expect(standings.map((r) => r.Rank)).toEqual(['1', '1', '3']);
    expect(standings.map((r) => r['Score after'])).toEqual(['400', '400', '-200']);
    expect(standings[2].Player).toBe('Béa, "B"\nSecond line');
    expect(standings.every((r) => r['Join code'] === '001234')).toBe(true);
  });
  it('exports each question including scoreless questions and individual misses', () => {
    const rows = records(resultsCsv(fixture()));
    const summary = rows.filter((r) => r['Record type'] === 'Question summary');
    expect(summary).toHaveLength(9);
    expect(
      summary.filter((r) => r['Question number'] === '2').every((r) => r['Score change'] === '0'),
    ).toBe(true);
    expect(
      summary.find((r) => r['Question number'] === '1' && r['Player ID'] === 'b'),
    ).toMatchObject({ 'Score change': '-200', 'Score after': '-200' });
    expect(
      rows.find((r) => r['Record type'] === 'Score event' && r.Detail === 'Incorrect'),
    ).toMatchObject({ 'Timestamp UTC': '1970-01-01T00:00:02.000Z' });
    expect(
      summary.find((r) => r['Question ID'] === 'final' && r['Player ID'] === 'a'),
    ).toMatchObject({ 'Score change': '200', 'Score after': '400' });
  });
  it('neutralizes formula-like text while retaining negative numeric values', () => {
    const s = fixture();
    s.title = ' \t+SUM(1,2)';
    const csv = resultsCsv(s);
    expect(csv).toContain('"\' \t+SUM(1,2)"');
    expect(csv).toContain('"\'=HYPERLINK(""bad"")"');
    expect(csv).toContain('"-200"');
  });
  it('excludes removed players from ranking but preserves their scoring history', () => {
    const s = fixture();
    s.players[1].removed = true;
    const row = records(resultsCsv(s)).find(
      (r) => r['Record type'] === 'Final standing' && r['Player ID'] === 'b',
    );
    expect(row).toMatchObject({ Rank: '', Removed: 'Yes', 'Score after': '-200' });
  });
  it('exports ended early sessions including the unfinished question and no unplayed questions or answers', () => {
    const s = fixture();
    s.phase = 'ended';
    s.used = [];
    s.events = [];
    s.questionId = s.board.questions[0].id;
    const csv = resultsCsv(s),
      rows = records(csv);
    expect(rows.filter((r) => r['Record type'] === 'Question summary')).toHaveLength(3);
    expect(rows.every((r) => r['Session status'] === 'Ended early')).toBe(true);
    expect(csv).not.toContain(s.board.final.answer);
    expect(csv).not.toContain(s.board.questions[2].prompt);
  });
  it('does not export an unopened Final question when the host ends during wagering', () => {
    const s = fixture();
    s.phase = 'ended';
    s.events = [];
    s.final = { a: { score: 400, wager: 100, text: '' } };
    const csv = resultsCsv(s);
    expect(csv).not.toContain(s.board.final.prompt);
    expect(records(csv).filter((r) => r['Record type'] === 'Question summary')).toHaveLength(6);
  });
  it('uses the surviving score ledger after an undo rather than the action history', () => {
    const s = fixture();
    s.events = [];
    s.used = [s.board.questions[0].id];
    const rows = records(resultsCsv(s));
    expect(rows.some((r) => r['Record type'] === 'Score event')).toBe(false);
    expect(
      rows
        .filter((r) => r['Record type'] === 'Question summary')
        .every((r) => r['Score change'] === '0'),
    ).toBe(true);
  });
});
