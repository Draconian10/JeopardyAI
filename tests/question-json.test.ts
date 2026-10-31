import { describe, it, expect } from 'vitest';
import {
  parseQuestionJson,
  boardToQuestionJson,
  questionJsonToBoard,
  QUESTION_JSON_EXAMPLE,
  MAX_QUESTION_JSON_LENGTH,
} from '@/lib/game/question-json';
import { starterBoard, blankBoard } from '@/lib/game/starter';
import { playable } from '@/lib/game/schema';
const example = () => JSON.parse(QUESTION_JSON_EXAMPLE);
describe('category-based question JSON', () => {
  it('imports categories, row order, answers, Daily Double and Final with generated question IDs', () => {
    const b = parseQuestionJson(QUESTION_JSON_EXAMPLE);
    playable(b);
    expect(b.categories).toEqual(['Science', 'Geography']);
    expect(b.rows).toBe(2);
    expect(b.questions).toHaveLength(4);
    expect(new Set(b.questions.map((q) => q.id)).size).toBe(4);
    expect(b.questions[1]).toMatchObject({
      category: 0,
      row: 1,
      value: 400,
      dailyDouble: true,
      answer: 'Au',
      notes: '',
    });
    expect(b.final.prompt).toContain('Shah Jahan');
  });
  it('round-trips a complete board without losing content', () => {
    const original = starterBoard();
    const json = boardToQuestionJson(original);
    const restored = questionJsonToBoard(json);
    expect(boardToQuestionJson(restored)).toEqual(json);
    expect(restored.questions[0].id).not.toBe(original.questions[0].id);
  });
  it('exports by row position even if the internal question array is shuffled', () => {
    const b = starterBoard();
    b.questions.reverse();
    expect(boardToQuestionJson(b).categories[0].questions.map((q) => q.value)).toEqual([
      200, 400, 600, 800, 1000,
    ]);
  });
  it('exports incomplete drafts without pretending they are importable complete games', () => {
    const json = boardToQuestionJson(blankBoard());
    expect(json.categories[0].questions[0].question).toBe('');
    expect(() => questionJsonToBoard(json)).toThrow();
  });
  it('rejects empty, malformed, null and oversized JSON', () => {
    expect(() => parseQuestionJson(' ')).toThrow('Paste');
    expect(() => parseQuestionJson('{bad')).toThrow('Invalid JSON');
    expect(() => parseQuestionJson('null')).toThrow();
    expect(() => parseQuestionJson('x'.repeat(MAX_QUESTION_JSON_LENGTH + 1))).toThrow('too large');
  });
  it('requires equal questions per category', () => {
    const v = example();
    v.categories[1].questions.pop();
    expect(() => questionJsonToBoard(v)).toThrow('same number');
  });
  it('rejects duplicate category names ignoring whitespace and case', () => {
    const v = example();
    v.categories[1].name = ' SCIENCE ';
    expect(() => questionJsonToBoard(v)).toThrow('unique');
  });
  it('requires exactly one Daily Double', () => {
    const v = example();
    delete v.categories[0].questions[1].dailyDouble;
    expect(() => questionJsonToBoard(v)).toThrow('exactly one');
    v.categories[0].questions[1].dailyDouble = true;
    v.categories[1].questions[0].dailyDouble = true;
    expect(() => questionJsonToBoard(v)).toThrow('exactly one');
  });
  it('rejects missing answers, blank categories and incomplete Final', () => {
    for (const mutate of [
      (v: ReturnType<typeof example>) => {
        v.categories[0].questions[0].answer = '  ';
      },
      (v: ReturnType<typeof example>) => {
        v.categories[0].name = '';
      },
      (v: ReturnType<typeof example>) => {
        delete v.final.question;
      },
    ]) {
      const v = example();
      mutate(v);
      expect(() => questionJsonToBoard(v)).toThrow();
    }
  });
  it('rejects invalid values and non-boolean flags without coercion', () => {
    for (const value of [-1, 0, 1.5, 100001, '200']) {
      const v = example();
      v.categories[0].questions[0].value = value;
      expect(() => questionJsonToBoard(v)).toThrow();
    }
    const v = example();
    v.categories[0].questions[0].dailyDouble = 'true';
    expect(() => questionJsonToBoard(v)).toThrow();
  });
  it('rejects unknown fields and embedded PINs', () => {
    const v = example();
    v.hostPin = '123456';
    expect(() => questionJsonToBoard(v)).toThrow();
    delete v.hostPin;
    v.categories[0].questions[0].points = 200;
    expect(() => questionJsonToBoard(v)).toThrow();
  });
  it('enforces board size and text limits', () => {
    const v = example();
    v.categories = Array.from({ length: 9 }, (_, i) => ({
      ...v.categories[0],
      name: `Category ${i}`,
    }));
    expect(() => questionJsonToBoard(v)).toThrow();
    const b = example();
    b.categories[0].questions[0].question = 'x'.repeat(3001);
    expect(() => questionJsonToBoard(b)).toThrow();
  });
  it('preserves multiline strings, notes and Unicode as plain text', () => {
    const v = example();
    v.categories[0].questions[0].question = '日本語\n<script>alert(1)</script>';
    v.categories[0].questions[0].notes = 'Also accept: MARS';
    const b = questionJsonToBoard(v);
    expect(b.questions[0].prompt).toBe(v.categories[0].questions[0].question);
    expect(b.questions[0].notes).toBe('Also accept: MARS');
  });
});
