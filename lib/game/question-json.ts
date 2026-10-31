import { z } from 'zod';
import { boardSchema, playable, type Board } from './schema';

export const MAX_QUESTION_JSON_LENGTH = 600000;
const requiredText = (max: number) => z.string().trim().min(1).max(max);
const importedQuestion = z
  .object({
    value: z.number().int().min(1).max(100000),
    question: requiredText(3000),
    answer: requiredText(2000),
    notes: z.string().trim().max(2000).default(''),
    dailyDouble: z.boolean().default(false),
  })
  .strict();

/** Portable authoring format: no internal UUIDs or positional indexes required. */
export const questionJsonSchema = z
  .object({
    title: requiredText(100),
    categories: z
      .array(
        z
          .object({
            name: requiredText(80),
            questions: z.array(importedQuestion).min(1).max(8),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    tiebreakers: z
      .array(
        z
          .object({
            category: requiredText(100),
            question: requiredText(3000),
            answer: requiredText(2000),
          })
          .strict(),
      )
      .max(20)
      .optional(),
    final: z
      .object({
        category: requiredText(100),
        question: requiredText(3000),
        answer: requiredText(2000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const rows = value.categories[0].questions.length;
    const names = new Set<string>();
    value.categories.forEach((category, index) => {
      if (category.questions.length !== rows)
        ctx.addIssue({
          code: 'custom',
          path: ['categories', index, 'questions'],
          message: 'Every category must have the same number of questions.',
        });
      const key = category.name.toLocaleLowerCase('en-US');
      if (names.has(key))
        ctx.addIssue({
          code: 'custom',
          path: ['categories', index, 'name'],
          message: 'Category names must be unique (ignoring case).',
        });
      names.add(key);
    });
    if (value.categories.flatMap((c) => c.questions).filter((q) => q.dailyDouble).length !== 1)
      ctx.addIssue({
        code: 'custom',
        path: ['categories'],
        message: 'Mark exactly one question with "dailyDouble": true.',
      });
  });
export type QuestionJson = z.infer<typeof questionJsonSchema>;

export function questionJsonToBoard(input: unknown): Board {
  const value = questionJsonSchema.parse(input);
  const board = boardSchema.parse({
    title: value.title,
    ...(value.tiebreakers !== undefined
      ? {
          tiebreakers: value.tiebreakers.map((q) => ({
            category: q.category,
            prompt: q.question,
            answer: q.answer,
          })),
        }
      : {}),
    categories: value.categories.map((c) => c.name),
    rows: value.categories[0].questions.length,
    questions: value.categories.flatMap((category, column) =>
      category.questions.map((q, row) => ({
        id: crypto.randomUUID(),
        category: column,
        row,
        value: q.value,
        prompt: q.question,
        answer: q.answer,
        notes: q.notes,
        dailyDouble: q.dailyDouble,
      })),
    ),
    final: {
      category: value.final.category,
      prompt: value.final.question,
      answer: value.final.answer,
    },
  });
  playable(board);
  return board;
}
export function parseQuestionJson(text: string): Board {
  if (text.length > MAX_QUESTION_JSON_LENGTH)
    throw new Error('JSON is too large. Use at most 600,000 characters.');
  if (!text.trim()) throw new Error('Paste your game JSON first.');
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('Invalid JSON. Check double quotes, commas, and closing brackets.');
  }
  return questionJsonToBoard(input);
}
/** Also works on incomplete drafts. Kept identical to the database generator. */
export function boardToQuestionJson(board: Board): QuestionJson {
  return {
    title: board.title,
    ...(board.tiebreakers !== undefined
      ? {
          tiebreakers: board.tiebreakers.map((q) => ({
            category: q.category,
            question: q.prompt,
            answer: q.answer,
          })),
        }
      : {}),
    categories: board.categories.map((name, index) => ({
      name,
      questions: board.questions
        .filter((q) => q.category === index)
        .sort((a, b) => a.row - b.row)
        .map((q) => ({
          value: q.value,
          question: q.prompt,
          answer: q.answer,
          notes: q.notes,
          dailyDouble: q.dailyDouble,
        })),
    })),
    final: {
      category: board.final.category,
      question: board.final.prompt,
      answer: board.final.answer,
    },
  };
}
export const QUESTION_JSON_EXAMPLE = JSON.stringify(
  {
    title: 'My trivia night',
    tiebreakers: [
      {
        category: 'World capitals',
        question: 'Which city is the capital of Canada?',
        answer: 'What is Ottawa?',
      },
      {
        category: 'Science',
        question: 'Which element has the chemical symbol He?',
        answer: 'What is helium?',
      },
    ],
    categories: [
      {
        name: 'Science',
        questions: [
          { value: 200, question: 'Which planet is known as the Red Planet?', answer: 'Mars' },
          {
            value: 400,
            question: 'What is the chemical symbol for gold?',
            answer: 'Au',
            dailyDouble: true,
          },
        ],
      },
      {
        name: 'Geography',
        questions: [
          { value: 200, question: 'What is the capital of Japan?', answer: 'Tokyo' },
          { value: 400, question: 'Which river flows through Paris?', answer: 'The Seine' },
        ],
      },
    ],
    final: {
      category: 'World Landmarks',
      question: 'Which Indian mausoleum was commissioned by Shah Jahan in memory of Mumtaz Mahal?',
      answer: 'The Taj Mahal',
    },
  },
  null,
  2,
);
