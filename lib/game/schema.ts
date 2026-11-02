import { z } from 'zod';
export const pinSchema = z.string().regex(/^\d{6}$/, 'Enter exactly six digits.');
const text = (max: number) => z.string().trim().max(max);
export const questionSchema = z
  .object({
    id: z.string().uuid(),
    category: z.number().int().min(0).max(7),
    row: z.number().int().min(0).max(7),
    value: z.number().int().min(1).max(100000),
    prompt: text(3000),
    answer: text(2000),
    notes: text(2000),
    dailyDouble: z.boolean(),
  })
  .strict();
export const tiebreakerClueSchema = z
  .object({ category: text(100), prompt: text(3000), answer: text(2000) })
  .strict();
export const boardSchema = z
  .object({
    title: text(100).min(1, 'Give your game a title.'),
    categories: z.array(text(80)).min(1).max(8),
    rows: z.number().int().min(1).max(8),
    tiebreakers: z.array(tiebreakerClueSchema).max(20).optional(),
    questions: z.array(questionSchema).min(1).max(64),
    final: z.object({ category: text(100), prompt: text(3000), answer: text(2000) }).strict(),
  })
  .strict()
  .superRefine((b, ctx) => {
    const positions = new Set<string>();
    const ids = new Set<string>();
    for (const q of b.questions) {
      const key = `${q.category}:${q.row}`;
      if (
        q.category >= b.categories.length ||
        q.row >= b.rows ||
        positions.has(key) ||
        ids.has(q.id)
      )
        ctx.addIssue({
          code: 'custom',
          message: 'Every board position and clue ID must be unique and inside the board.',
        });
      positions.add(key);
      ids.add(q.id);
    }
    if (positions.size !== b.categories.length * b.rows)
      ctx.addIssue({
        code: 'custom',
        message: 'The board must contain exactly one clue per position.',
      });
  });
export type Board = z.infer<typeof boardSchema>;
export function playable(board: Board) {
  boardSchema.parse(board);
  if (board.categories.some((c) => !c) || board.questions.some((q) => !q.prompt || !q.answer))
    throw new Error('Complete every category, clue, and correct response before starting.');
  if (board.questions.filter((q) => q.dailyDouble).length !== 1)
    throw new Error('Select exactly one Daily Double.');
  if (board.tiebreakers?.some((q) => !q.category || !q.prompt || !q.answer))
    throw new Error(
      'Complete every saved tiebreaker category, clue, and correct response, or remove the incomplete clue.',
    );
  if (!board.final.category || !board.final.prompt || !board.final.answer)
    throw new Error('Complete Final Jeopardy.');
}
const action = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...shape }).strict();
export const commandSchema = z.discriminatedUnion('type', [
  action('heartbeat', {}),
  action('claim', { pin: pinSchema, controller: z.string().uuid() }),
  action('join', {
    name: text(24)
      .min(1)
      .refine((s) => !/[\p{C}]/u.test(s), 'Use a printable name.'),
  }),
  action('start', {}),
  action('practiceStart', {}),
  action('practiceStop', {}),
  action('configure', {
    answerLimitSeconds: z
      .number()
      .int()
      .min(0)
      .max(60)
      .refine((n) => n === 0 || n >= 5, 'Choose Off or a whole number from 5 to 60 seconds.'),
  }),
  action('continue', {}),
  action('pause', {}),
  action('end', {}),
  action('lockLobby', { locked: z.boolean() }),
  action('remove', { playerId: z.string().uuid() }),
  action('select', { questionId: z.string().uuid() }),
  action('buzz', { windowId: z.string().uuid() }),
  action('judge', { correct: z.boolean() }),
  action('reveal', {}),
  action('next', {}),
  action('openDaily', {}),
  action('dailyWager', {
    amount: z.number().int().min(0).max(100000000),
  }),
  action('dailyJudge', { correct: z.boolean() }),
  action('wager', { amount: z.number().int().min(0).max(100000000) }),
  action('openFinal', {}),
  action('answer', { text: z.string().max(2000) }),
  action('reviewFinal', {}),
  action('finalJudge', { playerId: z.string().uuid(), correct: z.boolean() }),
  action('finish', {}),
  action('tieClue', {
    category: text(100).min(1),
    prompt: text(3000).min(1),
    answer: text(2000).min(1),
  }),
  action('tieJudge', { correct: z.boolean() }),
  action('tieNext', {}),
  action('tieSavedClue', {}),
  action('tieReveal', {}),
  action('undo', {}),
  action('tick', {}),
]);
export type Command = z.infer<typeof commandSchema>;
export const envelopeSchema = z
  .object({
    actionId: z.string().uuid(),
    version: z.number().int().min(0),
    controller: z.string().uuid().optional(),
    command: commandSchema,
  })
  .strict();
export const saveSchema = z
  .object({
    board: boardSchema,
    pin: pinSchema.optional(),
    version: z.number().int().min(0).optional(),
  })
  .strict();
