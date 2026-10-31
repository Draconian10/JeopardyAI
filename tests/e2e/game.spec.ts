import { test, expect, type Page } from '@playwright/test';
import { applyCommand, createSession, viewSession } from '../../lib/game/engine';
import { starterBoard } from '../../lib/game/starter';
import type { Session } from '../../lib/game/types';
const HOST = '11111111-1111-4111-8111-111111111111',
  PLAYER = '22222222-2222-4222-8222-222222222222',
  CONTROL = '33333333-3333-4333-8333-333333333333';
function fixture() {
  const s = createSession(
    starterBoard(),
    '44444444-4444-4444-8444-444444444444',
    HOST,
    '001234',
    Date.now(),
  );
  s.controller = CONTROL;
  s.players = [{ id: PLAYER, name: 'Alex', score: 0, lastSeen: Date.now(), removed: false }];
  return s;
}
async function mock(page: Page, initial: Session, userId = HOST) {
  let s = initial;
  const user = {
    id: userId,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'host@example.com',
    is_anonymous: userId !== HOST,
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}.test`;
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem(
        'sb-example-auth-token',
        JSON.stringify({
          access_token: token,
          refresh_token: 'test',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user,
        }),
      );
    },
    { token, user },
  );
  await page.route('https://example.supabase.co/auth/v1/**', (route) =>
    route.fulfill({ json: user }),
  );
  await page.routeWebSocket(/example\.supabase\.co/, (socket) => socket.close());
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    let controller = request.headers()['x-controller'];
    if (url.pathname === '/api/games')
      return route.fulfill({
        json: {
          games: [
            {
              id: s.gameId,
              title: s.title,
              version: 0,
              updatedAt: new Date().toISOString(),
              archived: false,
            },
          ],
          sessions: [
            {
              id: s.id,
              gameId: s.gameId,
              joinCode: s.joinCode,
              active: true,
              phase: s.phase,
              players: s.players.length,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    if (url.pathname === `/api/games/${s.gameId}` && request.method() === 'GET')
      return route.fulfill({ json: { id: s.gameId, board: s.board, version: 0 } });
    if (url.pathname === `/api/games/${s.gameId}` && request.method() === 'PUT')
      return route.fulfill({ json: { id: s.gameId, version: 1 } });
    if (url.pathname === `/api/sessions/${s.id}/command`) {
      const body = request.postDataJSON();
      controller = body.controller;
      try {
        s = applyCommand(s, body.command, {
          userId,
          now: Date.now(),
          controller,
          actionId: body.actionId,
          expectedVersion: body.version,
          pinVerified: body.command.pin === '123456',
        });
      } catch (error) {
        return route.fulfill({ status: 400, json: { error: (error as Error).message } });
      }
    }
    return route.fulfill({
      json: viewSession(
        s,
        userId,
        Date.now(),
        controller,
        url.searchParams.get('view') === 'audience',
      ),
    });
  });
  return () => s;
}
test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === 'passed')
    await page.screenshot({ path: testInfo.outputPath('screen.png'), fullPage: true });
});

test('home offers hosting and joining without horizontal overflow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /A board full of questions/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Host a game/ })).toHaveAttribute('href', '/host');
  await expect(page.getByRole('link', { name: /Join a game/ })).toHaveAttribute('href', '/join');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('host can reopen a persisted session, claim it, continue and start', async ({ page }) => {
  const s = fixture();
  s.paused = true;
  s.pauseReason = 'Host disconnected';
  const current = await mock(page, s);
  await page.goto('/host');
  await page.getByRole('link', { name: 'Resume', exact: false }).click();
  await page.getByLabel('Host PIN').fill('123456');
  await page.getByRole('button', { name: 'Resume / take control' }).click();
  await page.getByRole('button', { name: 'Continue game', exact: false }).first().click();
  await expect(page.getByText('001234', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Start Jeopardy' }).click();
  await expect(page.locator('.jeopardy-board')).toBeVisible();
  expect(current().id).toBe(s.id);
  expect(current().players[0].name).toBe('Alex');
});
test('mobile player buzzer is server-confirmed and duplicate buzzing is disabled', async ({
  page,
}) => {
  let s = fixture();
  s.phase = 'board';
  s = applyCommand(
    s,
    { type: 'select', questionId: s.board.questions[0].id },
    {
      userId: HOST,
      now: Date.now(),
      controller: CONTROL,
      actionId: crypto.randomUUID(),
      expectedVersion: s.actionVersion,
    },
  );
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await page.getByRole('button', { name: 'BUZZ!', exact: false }).click();
  await expect(page.getByRole('button', { name: 'YOU’RE UP!', exact: false })).toBeDisabled();
  await expect(page.getByText('Give your answer to the host.')).toBeVisible();
  expect(current().respondent).toBe(PLAYER);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('editor supports selecting a tile and saving a structured board', async ({ page }) => {
  const s = fixture();
  await mock(page, s);
  await page.goto(`/host/edit/${s.gameId}`);
  await expect(page.getByRole('heading', { name: 'The board is yours.' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Question', exact: true }).fill('A revised question');
  await page.getByRole('button', { name: 'Save game' }).click();
  await expect(page.getByRole('status')).toContainText('All changes saved');
});
test('Final Jeopardy draft is saved and kept on the server', async ({ page }) => {
  const s = fixture();
  s.phase = 'finalAnswer';
  s.remaining = 30000;
  s.deadline = Date.now() + 30000;
  s.final = { [PLAYER]: { score: 0, wager: 0, text: '' } };
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await page.getByLabel('Your answer', { exact: true }).fill('The Taj Mahal');
  await expect.poll(() => current().final[PLAYER].text).toBe('The Taj Mahal');
  await expect(page.getByRole('status')).toContainText('Saved');
});
test('audience view never displays private host answers', async ({ page }) => {
  const s = fixture();
  s.phase = 'question';
  s.questionId = s.board.questions[0].id;
  s.deadline = Date.now() + 30000;
  await mock(page, s);
  await page.goto(`/display/${s.id}`);
  await expect(page.getByRole('heading', { name: s.board.questions[0].prompt })).toBeVisible();
  await expect(page.getByText(s.board.questions[0].answer, { exact: true })).toHaveCount(0);
  await expect(page.getByText('Private host answer')).toHaveCount(0);
});
