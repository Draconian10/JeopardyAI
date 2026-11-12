import { test, expect } from '@playwright/test';
import { createSession, viewSession } from '../../lib/game/engine';
import { starterBoard } from '../../lib/game/starter';

test('private audience link displays a sanitized board without a Supabase login', async ({ page }) => {
  const host = crypto.randomUUID();
  const s = createSession(starterBoard(), crypto.randomUUID(), host, '217654', Date.now());
  s.players = [{
    id: crypto.randomUUID(), name: 'Ada', score: 1200, lastSeen: Date.now(), removed: false,
  }];
  s.phase = 'question';
  s.questionId = s.board.questions[0].id;
  s.deadline = Date.now() + 30_000;
  s.remaining = 30_000;
  const projection = {
    ...viewSession(s, host, Date.now(), undefined, true),
    controllerOwned: false,
  };
  let requested = 0;
  await page.route('**/api/display/**', async (route) => {
    requested++;
    await route.fulfill({ json: projection });
  });
  await page.goto(`/display/${s.id}?token=${'A'.repeat(32)}`);
  await expect(page.getByText(s.title).first()).toBeVisible();
  await expect(page.getByText('Ada')).toBeVisible();
  await expect(page.getByText(s.board.questions[0].answer, { exact: true })).toHaveCount(0);
  await expect(page.getByText('HOST CONTROLS')).toHaveCount(0);
  expect(requested).toBeGreaterThan(0);
});

test('display URL without a link does not expose a board to an unauthenticated visitor', async ({
  page,
}) => {
  const sessionId = crypto.randomUUID();
  await page.goto(`/display/${sessionId}`);
  await expect(page.getByText('Sign in or join the game again in this browser.')).toBeVisible();
});
