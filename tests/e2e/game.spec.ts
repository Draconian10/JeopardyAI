import { readFile } from 'node:fs/promises';
import { resultsCsv } from '../../lib/game/results-csv';
import { test, expect, type Page, type Route } from '@playwright/test';
import { applyCommand, createSession, viewSession, reconcile } from '../../lib/game/engine';
import { starterBoard } from '../../lib/game/starter';
import { playerSessionSummary } from '../../lib/game/player-sessions';
import { parseQuestionJson, QUESTION_JSON_EXAMPLE } from '../../lib/game/question-json';
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
    if (url.pathname === '/api/player-sessions') {
      const summary = playerSessionSummary(s, userId);
      return route.fulfill({ json: { sessions: summary ? [summary] : [] } });
    }
    if (url.pathname === '/api/games/import') {
      try {
        return route.fulfill({ json: { board: parseQuestionJson(request.postDataJSON().text) } });
      } catch (error) {
        return route.fulfill({ status: 400, json: { error: (error as Error).message } });
      }
    }
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
              title: s.title,
              joinCode: s.joinCode,
              active: !['ended', 'finished'].includes(s.phase),
              phase: s.phase,
              players: s.players.length,
              createdAt: new Date().toISOString(),
            },
          ],
        },
      });
    if (url.pathname === `/api/games/${s.gameId}/start`) {
      const body = request.postDataJSON();
      if (body.pin !== '123456')
        return route.fulfill({ status: 403, json: { error: 'Incorrect host PIN.' } });
      const next = createSession(s.board, s.gameId, HOST, '001234', Date.now(), body.controller);
      next.id = body.requestId;
      s = next;
      return route.fulfill({ status: 201, json: { id: s.id } });
    }
    if (url.pathname === `/api/sessions/${s.id}/results`) {
      if (userId !== HOST || !['finished', 'ended'].includes(s.phase))
        return route.fulfill({ status: 403, json: { error: 'Not allowed.' } });
      return route.fulfill({ contentType: 'text/csv; charset=utf-8', body: resultsCsv(s) });
    }
    if (url.pathname === `/api/games/${s.gameId}` && request.method() === 'GET')
      return route.fulfill({ json: { id: s.gameId, board: s.board, version: 0 } });
    if (url.pathname === `/api/games/${s.gameId}` && request.method() === 'PUT')
      return route.fulfill({ json: { id: s.gameId, version: 1 } });
    if (url.pathname === `/api/sessions/${s.id}/end`) {
      const body = request.postDataJSON();
      if (userId !== HOST || body.confirmed !== true)
        return route.fulfill({ status: 403, json: { error: 'Not authorized or unconfirmed' } });
      s = applyCommand(
        s,
        { type: 'end' },
        {
          userId,
          now: Date.now(),
          actionId: body.actionId,
          expectedVersion: s.actionVersion,
          dashboardEnd: true,
        },
      );
      return route.fulfill({ json: { id: s.id, ended: true } });
    }
    if (url.pathname === `/api/sessions/${s.id}/command`) {
      const body = request.postDataJSON();
      controller = body.controller;
      try {
        if (body.command.type === 'heartbeat') {
          if (userId === HOST && controller !== s.controller)
            return route.fulfill({
              status: 409,
              json: { error: 'Another tab controls this game.' },
            });
          reconcile(s, Date.now());
          if (userId === HOST) s.hostSeen = Date.now();
          else {
            const player = s.players.find((p) => p.id === userId && !p.removed);
            if (player) player.lastSeen = Date.now();
          }
          return route.fulfill({
            json: { kind: 'heartbeat', serverNow: Date.now(), host: userId === HOST },
          });
        }
        if (body.command.type === 'answer') {
          const next = applyCommand(s, body.command, {
            userId,
            now: Date.now(),
            controller,
            actionId: body.actionId,
            expectedVersion: body.version,
          });
          s.final[userId] = next.final[userId];
          const entry = s.final[userId];
          return route.fulfill({
            json: {
              kind: 'answer',
              serverNow: Date.now(),
              text: entry.text,
              submittedAt: entry.submittedAt,
              revision: entry.revision,
            },
          });
        }
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
    if (request.method() === 'GET' && url.pathname === `/api/sessions/${s.id}`) {
      const before = JSON.stringify(s);
      reconcile(s, Date.now());
      if (JSON.stringify(s) !== before) {
        s.version++;
        s.actionVersion++;
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
  await expect(page.getByRole('heading', { name: /A board full of clues/ })).toBeVisible();
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
  await expect(page.getByText('Give your response to the host.')).toBeVisible();
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
  await page
    .locator('.question-editor')
    .getByRole('textbox', { name: 'Clue', exact: true })
    .fill('A revised question');
  await page.getByRole('button', { name: 'Save board' }).click();
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
  await page.getByLabel('Your response', { exact: true }).fill('The Taj Mahal');
  await expect.poll(() => current().final[PLAYER].text).toBe('The Taj Mahal');
  await expect(page.locator('.player-game form [role="status"]')).toContainText('Saved');
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
  await expect(page.getByText('Private correct response')).toHaveCount(0);
});

test('JSON import validates before replacing the board and can save imported questions', async ({
  page,
}) => {
  const s = fixture();
  await mock(page, s);
  await page.goto(`/host/edit/${s.gameId}`);
  await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
  await page.getByLabel('Board JSON', { exact: true }).fill('{broken');
  await page.getByRole('button', { name: 'Validate & apply JSON' }).click();
  await expect(
    page.getByText('Invalid JSON. Check double quotes, commas, and closing brackets.'),
  ).toBeVisible();
  await expect(page.getByLabel('Board title', { exact: true })).toHaveValue(s.title);
  await page.getByRole('button', { name: 'Load JSON example' }).click();
  await expect(page.getByLabel('Board JSON', { exact: true })).toHaveValue(QUESTION_JSON_EXAMPLE);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Validate & apply JSON' }).click();
  await expect(page.getByLabel('Board title', { exact: true })).toHaveValue('My trivia night');
  await expect(
    page.locator('.question-editor').getByRole('textbox', { name: 'Clue', exact: true }),
  ).toHaveValue('Which planet is known as the Red Planet?');
  const saved = page.waitForRequest(
    (request) => request.url().includes(`/api/games/${s.gameId}`) && request.method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save board', exact: true }).click();
  const imported = (await saved).postDataJSON().board;
  expect(imported.categories).toEqual(['Science', 'Geography']);
  expect(imported.tiebreakers).toHaveLength(2);
});

test('canceling a JSON import preserves the existing board', async ({ page }) => {
  const s = fixture();
  await mock(page, s);
  await page.goto(`/host/edit/${s.gameId}`);
  await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
  await page.getByRole('button', { name: 'Load JSON example' }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Validate & apply JSON' }).click();
  await expect(page.getByLabel('Board title', { exact: true })).toHaveValue(s.title);
  await expect(page.locator('.board-tile')).toHaveCount(30);
});

test('player can return from Home after a refresh without rejoining or losing their score', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'board';
  s.players[0].score = 800;
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Return to game' })).toHaveAttribute(
    'href',
    `/play/${s.id}`,
  );
  await page.reload();
  await page.getByRole('link', { name: 'Return to game' }).click();
  await expect(page.getByRole('heading', { name: 'Let’s go, Alex.' })).toBeVisible();
  await expect(page.locator('.personal-score strong')).toHaveText('$800');
  expect(current().players).toHaveLength(1);
  expect(current().players[0].score).toBe(800);
});

test('Join Game also offers a direct return for an existing player', async ({ page }) => {
  const s = fixture();
  await mock(page, s, PLAYER);
  await page.goto('/join');
  await page.getByRole('link', { name: 'Return to game' }).click();
  await expect(page.getByRole('heading', { name: 'You’ve got a seat.' })).toBeVisible();
});

test('ended sessions do not show a player return link', async ({ page }) => {
  const s = fixture();
  s.phase = 'ended';
  await mock(page, s, PLAYER);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Join a game' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Return to game' })).toHaveCount(0);
});

async function claimHost(page: Page, s: Session) {
  await page.goto(`/host/session/${s.id}`);
  await page.getByLabel('Host PIN').fill('123456');
  await page.getByRole('button', { name: 'Resume / take control' }).click();
  await page.getByRole('button', { name: 'Continue game', exact: false }).first().click();
}
test('dashboard can end a session directly without entering a host PIN', async ({ page }) => {
  const s = fixture();
  const current = await mock(page, s);
  await page.goto('/host');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: `End session ${s.joinCode}`, exact: true }).click();
  await expect(page.getByRole('link', { name: 'Resume', exact: false })).toHaveCount(0);
  expect(current().phase).toBe('ended');
  expect(current().players).toHaveLength(1);
  await expect(page.getByLabel('Host PIN')).toHaveCount(0);
});
test('canceling dashboard end keeps the session active', async ({ page }) => {
  const s = fixture();
  const current = await mock(page, s);
  await page.goto('/host');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: `End session ${s.joinCode}`, exact: true }).click();
  expect(current().phase).toBe('lobby');
  await expect(page.getByRole('link', { name: 'Resume', exact: false })).toBeVisible();
});
test('host configures an response deadline and runs practice before the real game', async ({
  page,
}) => {
  const s = fixture();
  const current = await mock(page, s);
  await claimHost(page, s);
  await page.getByLabel('Response deadline after buzzing', { exact: true }).selectOption('10');
  await expect.poll(() => current().answerLimitSeconds).toBe(10);
  await page.getByRole('button', { name: 'Start practice round', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Practice buzzer round' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset practice buzzer' }).click();
  await page.getByRole('button', { name: 'Finish practice', exact: false }).click();
  await expect(page.getByRole('button', { name: 'Start Jeopardy' })).toBeVisible();
  expect(current().players[0].score).toBe(0);
  expect(current().used).toHaveLength(0);
});
test('player can win a practice buzz without earning points', async ({ page }) => {
  const s = fixture();
  s.phase = 'practiceOpen';
  s.windowId = crypto.randomUUID();
  s.deadline = Date.now() + 30000;
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await page.getByRole('button', { name: 'BUZZ!', exact: false }).click();
  await expect(page.getByText('Alex buzzed first!')).toBeVisible();
  expect(current().players[0].score).toBe(0);
  expect(current().events).toHaveLength(0);
});
test('standings reorder with rank movement when an answer changes the leader', async ({ page }) => {
  const s = fixture();
  const second = '55555555-5555-4555-8555-555555555555';
  s.players[0].score = 1000;
  s.players.push({ id: second, name: 'Sam', score: 800, lastSeen: Date.now(), removed: false });
  s.phase = 'answering';
  s.questionId = s.board.questions.find((q) => q.value === 400 && !q.dailyDouble)!.id;
  s.respondent = second;
  await mock(page, s);
  await claimHost(page, s);
  await page.getByRole('button', { name: 'Correct', exact: true }).click();
  await expect(page.locator('.score-sidebar .standing-row').first()).toHaveAttribute(
    'data-player-id',
    second,
  );
  await expect(page.locator('.reveal-stage .standing-row').first()).toHaveAttribute(
    'data-player-id',
    second,
  );
  await expect(page.locator('.score-sidebar').getByLabel('Moved up 1 place')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.score-sidebar .standing-row')
        .evaluateAll(
          (rows) =>
            rows.flatMap((row) => row.getAnimations()).filter((a) => a.playState === 'running')
              .length,
        ),
    )
    .toBe(0);
});

test('response deadline expires on the server and deducts points before reopening the buzzer', async ({
  page,
}) => {
  const s = fixture();
  const second = '55555555-5555-4555-8555-555555555555';
  s.players.push({ id: second, name: 'Sam', score: 0, lastSeen: Date.now(), removed: false });
  s.phase = 'answering';
  s.questionId = s.board.questions[0].id;
  s.respondent = PLAYER;
  s.windowId = crypto.randomUUID();
  s.answerLimitSeconds = 5;
  s.answerRemaining = 1200;
  s.answerDeadline = Date.now() + 1200;
  s.remaining = 29000;
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect.poll(() => current().phase).toBe('question');
  await expect(page.locator('.personal-score strong')).toHaveText('-$200');
  await expect(page.getByText(/Response time expired for Alex/)).toBeVisible();
  expect(current().events).toHaveLength(1);
});

const settleFrames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

test('temporary background fetch errors clear after recovery without buzzing or losing the score', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'board';
  s.players[0].score = 800;
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.locator('.personal-score strong')).toHaveText('$800');
  let failReads = true;
  await page.route(`**/api/sessions/${s.id}`, async (route) => {
    if (failReads) return route.abort('failed');
    return route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.session-container p[role="alert"]')).toContainText(
    /Failed to fetch/i,
  );
  await expect(page.locator('.personal-score strong')).toHaveText('$800');
  current().players[0].score = 1000;
  current().version++;
  failReads = false;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(page.locator('.personal-score strong')).toHaveText('$1,000');
  await expect(page.locator('.session-container p[role="alert"]')).toBeEmpty();
  await expect(page.locator('.connection')).toHaveText('Connected');
});

test('a gameplay validation error survives successful synchronization and clears on the next action', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'question';
  s.windowId = crypto.randomUUID();
  s.questionId = s.board.questions[0].id;
  s.deadline = Date.now() + 30000;
  await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.getByRole('button', { name: 'BUZZ!', exact: false })).toBeEnabled();
  let reject = true;
  await page.route(`**/api/sessions/${s.id}/command`, async (route) => {
    if (reject && route.request().postDataJSON().command.type === 'buzz') {
      reject = false;
      return route.fulfill({ status: 400, json: { error: 'You already answered this clue.' } });
    }
    return route.fallback();
  });
  await page.getByRole('button', { name: 'BUZZ!', exact: false }).click();
  await expect(page.locator('.session-container p[role="alert"]')).toHaveText(
    'You already answered this clue.',
  );
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().endsWith(`/api/sessions/${s.id}`) && r.request().method() === 'GET',
    ),
    page.evaluate(() => window.dispatchEvent(new Event('focus'))),
  ]);
  await expect(page.locator('.session-container p[role="alert"]')).toHaveText(
    'You already answered this clue.',
  );
  await page.getByRole('button', { name: 'BUZZ!', exact: false }).click();
  await expect(page.getByRole('button', { name: 'YOU’RE UP!', exact: false })).toBeVisible();
  await expect(page.locator('.session-container p[role="alert"]')).toBeEmpty();
});

test('a queued refresh recovers after a delayed fetch failure without losing the score', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'board';
  s.players[0].score = 600;
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.locator('.personal-score strong')).toHaveText('$600');
  let delayed: Route | undefined;
  let first = true;
  await page.route(`**/api/sessions/${s.id}`, async (route) => {
    if (first) {
      first = false;
      delayed = route;
      return;
    }
    return route.fallback();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => !!delayed).toBe(true);
  current().players[0].score = 900;
  current().version++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.personal-score strong')).toHaveText('$600');
  await delayed!.abort('failed');
  await expect(page.locator('.personal-score strong')).toHaveText('$900');
  await settleFrames(page);
  await expect(page.locator('.session-container p[role="alert"]')).toBeEmpty();
  await expect(page.locator('.connection')).toHaveText('Connected');
});

function finalFixture() {
  const s = fixture();
  s.phase = 'finished';
  s.players[0].score = 2400;
  s.final = {
    [PLAYER]: { score: 1200, wager: 1200, text: 'The Taj Mahal', judged: true, correct: true },
  };
  return s;
}

test('final results launch a short confetti burst without blocking controls', async ({
  page,
}, testInfo) => {
  const s = finalFixture();
  await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.getByRole('heading', { name: 'Alex wins!', exact: true })).toBeVisible();
  const confetti = page.getByTestId('results-confetti');
  await expect(confetti).toBeVisible();
  await expect(confetti).toHaveCSS('pointer-events', 'none');
  await expect
    .poll(() =>
      confetti.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const pixels = canvas
          .getContext('2d')!
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let top = canvas.height,
          bottom = 0;
        for (let y = 0; y < canvas.height; y += 4) {
          for (let x = 0; x < canvas.width; x += 4) {
            if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
          }
        }
        return (bottom - top) / canvas.height;
      }),
    )
    .toBeGreaterThan(0.12);
  await page.screenshot({ path: testInfo.outputPath('confetti-burst.png'), fullPage: true });

  await expect(page.locator('.final-celebration')).toContainText('$2,400');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !!sessionStorage.getItem(
            'jeopardy:results-confetti:' + location.pathname.split('/').pop(),
          ),
      ),
    )
    .toBe(true);
  await expect(confetti).toHaveCount(0, { timeout: 5000 });
});

test('confetti does not replay when the same results page is refreshed', async ({ page }) => {
  const s = finalFixture();
  await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.getByTestId('results-confetti')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Alex wins!', exact: true })).toBeVisible();
  await settleFrames(page);
  await expect(page.getByTestId('results-confetti')).toHaveCount(0);
});

test('final results respect reduced motion and remain fully usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const s = finalFixture();
  await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.getByRole('heading', { name: 'Alex wins!', exact: true })).toBeVisible();
  await settleFrames(page);
  await expect(page.getByTestId('results-confetti')).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to home', exact: false }).click();
  await expect(page).toHaveURL('/');
});

test('ending a session early does not trigger winner confetti', async ({ page }) => {
  const s = fixture();
  s.phase = 'ended';
  await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.getByRole('heading', { name: 'Thanks for playing.' })).toBeVisible();
  await settleFrames(page);
  await expect(page.getByTestId('results-confetti')).toHaveCount(0);
});

test('fresh launch opens a controlled unpaused lobby after one PIN and reload still requires resume', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'finished';
  const current = await mock(page, s);
  await page.goto('/host');
  await page.getByRole('button', { name: 'Start session', exact: true }).click();
  await page.getByLabel('Host PIN').fill('123456');
  await page.getByRole('button', { name: 'Open lobby', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start Jeopardy', exact: true })).toBeVisible();
  await expect(page.getByLabel('Host PIN')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Continue game', exact: false })).toHaveCount(0);
  expect(current().paused).toBe(false);
  expect(current().players).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume / take control' })).toBeVisible();
  await page.getByLabel('Host PIN').fill('123456');
  await page.getByRole('button', { name: 'Resume / take control' }).click();
  await expect(
    page.getByRole('button', { name: 'Continue game', exact: false }).first(),
  ).toBeVisible();
  expect(current().paused).toBe(true);
});

for (const phase of ['finished', 'ended'] as const) {
  test(`host downloads ${phase} results with standings and question scores`, async ({ page }) => {
    const s = finalFixture();
    s.phase = phase;
    const q = s.board.questions[0];
    s.used = [q.id];
    s.events = [
      {
        id: crypto.randomUUID(),
        questionId: q.id,
        playerId: PLAYER,
        delta: 200,
        reason: 'Correct',
        at: Date.now(),
      },
    ];
    await mock(page, s);
    await page.goto(`/host/session/${s.id}`);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download results (CSV)', exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe(`jeopardy-results-${s.id}.csv`);
    const csv = await readFile((await download.path())!, 'utf8');
    expect(csv).toContain('"Final standing"');
    expect(csv).toContain('"Clue summary"');
    expect(csv).toContain('"Score event"');
    expect(csv).toContain('"2400"');
    expect(csv).toContain(q.prompt.replace(/"/g, '""'));
    await expect(
      page.getByRole('button', { name: 'Download results (CSV)', exact: true }),
    ).toBeEnabled();
  });
}

test('failed results download shows a retryable error without leaving the results', async ({
  page,
}) => {
  const s = finalFixture();
  await mock(page, s);
  await page.route(`**/api/sessions/${s.id}/results`, (route) =>
    route.fulfill({ status: 503, json: { error: 'Could not load results. Please retry.' } }),
  );
  await page.goto(`/host/session/${s.id}`);
  await page.getByRole('button', { name: 'Download results (CSV)' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Could not load results. Please retry.' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download results (CSV)' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Alex wins!', exact: true })).toBeVisible();
});

test('player results do not offer the host-only CSV download', async ({ page }) => {
  const s = finalFixture();
  await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.getByRole('heading', { name: 'Alex wins!', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download results (CSV)' })).toHaveCount(0);
});

const TIED_OTHER = '55555555-5555-4555-8555-555555555555';
const SPECTATOR = '66666666-6666-4666-8666-666666666666';
function tiedFinal() {
  const s = fixture();
  s.phase = 'finalReview';
  s.players = [
    { id: PLAYER, name: 'Alex', score: 1000, lastSeen: Date.now(), removed: false },
    { id: TIED_OTHER, name: 'Sam', score: 1000, lastSeen: Date.now(), removed: false },
    { id: SPECTATOR, name: 'Pat', score: 400, lastSeen: Date.now(), removed: false },
  ];
  s.final = Object.fromEntries(
    s.players.map((p) => [
      p.id,
      { score: p.score, wager: 0, text: 'Answer', judged: true, correct: true },
    ]),
  );
  return s;
}
async function openControlledHost(page: Page, s: Session) {
  await page.goto(`/host/session/${s.id}`);
  await page.getByLabel('Host PIN').fill('123456');
  await page.getByRole('button', { name: 'Resume / take control' }).click();
  await page.getByRole('button', { name: 'Continue game', exact: false }).first().click();
}
async function simulateBuzz(page: Page, current: () => Session, playerId: string) {
  const s = current();
  Object.assign(
    s,
    applyCommand(
      s,
      { type: 'buzz', windowId: s.windowId! },
      {
        userId: playerId,
        now: Date.now(),
        actionId: crypto.randomUUID(),
        expectedVersion: s.actionVersion,
      },
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}
async function fillTieClue(page: Page, suffix = '') {
  await page.getByLabel('Tiebreaker category', { exact: true }).fill('Capital cities');
  await page
    .getByLabel('Tiebreaker clue', { exact: true })
    .fill('This is the capital of France.' + suffix);
  await page.getByLabel('Tiebreaker correct response', { exact: true }).fill('What is Paris?');
  await page.getByRole('button', { name: 'Present clue & open buzzers' }).click();
}
test('tied Final leaders play sudden death and only a correct response wins without changing scores', async ({
  page,
}) => {
  const s = tiedFinal(),
    current = await mock(page, s);
  await openControlledHost(page, s);
  await page.getByRole('button', { name: 'Start sudden-death tiebreaker' }).click();
  await expect(
    page.getByRole('heading', { name: 'Tied for first. One correct response wins.' }),
  ).toBeVisible();
  await expect(page.getByTestId('results-confetti')).toHaveCount(0);
  await fillTieClue(page);
  await expect(
    page.getByRole('heading', { name: 'This is the capital of France.', exact: true }),
  ).toBeVisible();
  await simulateBuzz(page, current, PLAYER);
  await expect(page.getByRole('heading', { name: 'Clue hidden while Alex answers' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'This is the capital of France.', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'This is the capital of France.', exact: true }),
  ).toBeVisible();
  expect(current().tiebreaker?.winnerId).toBeUndefined();
  await simulateBuzz(page, current, TIED_OTHER);
  await page.getByRole('button', { name: 'Correct · wins game', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sam wins!', exact: true })).toBeVisible();
  expect(current().players.map((p) => p.score)).toEqual([1000, 1000, 400]);
  await expect(page.locator('.standing-row').first()).toHaveAttribute('data-player-id', TIED_OTHER);
});
test('everyone missing leads to another tiebreaker clue with all tied leaders eligible again', async ({
  page,
}) => {
  const s = applyCommand(
    tiedFinal(),
    { type: 'finish' },
    {
      userId: HOST,
      now: Date.now(),
      controller: CONTROL,
      actionId: crypto.randomUUID(),
      expectedVersion: 0,
    },
  );
  const current = await mock(page, s);
  await openControlledHost(page, s);
  await fillTieClue(page);
  for (const id of [PLAYER, TIED_OTHER]) {
    await simulateBuzz(page, current, id);
    await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  }
  await expect(
    page.getByText('No correct response. No winner yet;', { exact: false }),
  ).toBeVisible();
  await expect(page.getByTestId('results-confetti')).toHaveCount(0);
  await page.getByRole('button', { name: 'Prepare another clue' }).click();
  await fillTieClue(page, ' Second clue');
  expect(current().tiebreaker?.rounds).toHaveLength(2);
  expect(current().attempted).toEqual([]);
  expect(current().tiebreaker?.playerIds).toEqual([PLAYER, TIED_OTHER]);
});
for (const eligible of [true, false]) {
  test(`tiebreaker buzzer is ${eligible ? 'enabled for a leader' : 'disabled for a nonleader'}`, async ({
    page,
  }) => {
    let s = applyCommand(
      tiedFinal(),
      { type: 'finish' },
      {
        userId: HOST,
        now: Date.now(),
        controller: CONTROL,
        actionId: crypto.randomUUID(),
        expectedVersion: 0,
      },
    );
    s = applyCommand(
      s,
      { type: 'tieClue', category: 'Cities', prompt: 'A capital city.', answer: 'Paris' },
      {
        userId: HOST,
        now: Date.now(),
        controller: CONTROL,
        actionId: crypto.randomUUID(),
        expectedVersion: s.actionVersion,
      },
    );
    const current = await mock(page, s, eligible ? PLAYER : SPECTATOR);
    await page.goto(`/play/${s.id}`);
    const buzzer = page.locator('.tie-stage .buzzer');
    if (eligible) {
      await expect(buzzer).toBeEnabled();
      await buzzer.click();
      await expect(buzzer).toHaveText(/YOU’RE UP!/);
      expect(current().phase).toBe('tieAnswer');
    } else {
      await expect(buzzer).toBeDisabled();
      await expect(
        page.getByText('Only the tied leaders can buzz.', { exact: true }),
      ).toBeVisible();
    }
  });
}
test('host clue disappears after a buzz and reappears after an incorrect response', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'board';
  s.players.push({ id: TIED_OTHER, name: 'Sam', score: 0, lastSeen: Date.now(), removed: false });
  const current = await mock(page, s);
  await openControlledHost(page, s);
  await page.locator('.board-tile:not(:disabled)').first().click();
  const prompt = current().board.questions.find((q) => q.id === current().questionId)!.prompt;
  await expect(page.getByRole('heading', { name: prompt, exact: true })).toBeVisible();
  await simulateBuzz(page, current, PLAYER);
  await expect(page.getByRole('heading', { name: prompt, exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Clue hidden while Alex answers' })).toBeVisible();
  await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  expect(current().phase).toBe('question');
  expect(current().respondent).toBeUndefined();
  await expect(page.getByRole('heading', { name: prompt, exact: true })).toBeVisible();
});
test('stale stage errors clear automatically on the next clue without hiding same-stage validation', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'question';
  s.questionId = s.board.questions[0].id;
  s.windowId = crypto.randomUUID();
  s.deadline = Date.now() + 30000;
  const current = await mock(page, s, PLAYER);
  await page.route(`**/api/sessions/${s.id}/command`, async (route) => {
    if (route.request().postDataJSON().command.type === 'buzz')
      return route.fulfill({
        status: 400,
        json: { error: 'That action is not available at this stage.' },
      });
    return route.fallback();
  });
  await page.goto(`/play/${s.id}`);
  await page.getByRole('button', { name: 'BUZZ!', exact: false }).click();
  await expect(page.locator('.session-container > p[role="alert"]')).toHaveText(
    'That action is not available at this stage.',
  );
  current().questionId = s.board.questions[1].id;
  current().windowId = crypto.randomUUID();
  current().version++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.session-container > p[role="alert"]')).toBeEmpty();
});
test('projector view uses large wrapped high-contrast clue text without exposing host answers', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const s = fixture();
  s.phase = 'question';
  s.questionId = s.board.questions[0].id;
  s.deadline = Date.now() + 30000;
  s.board.questions[0].prompt = 'A long, readable clue on a large screen. '.repeat(7);
  await mock(page, s);
  await page.goto(`/display/${s.id}`);
  const heading = page.locator('.question-stage > h2');
  await expect(heading).toBeVisible();
  expect(
    await heading.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(50);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.locator('.host-answer')).toHaveCount(0);
});

test('late validation failure from the old question cannot reappear on a new question', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'question';
  s.questionId = s.board.questions[0].id;
  s.windowId = crypto.randomUUID();
  s.deadline = Date.now() + 30000;
  const current = await mock(page, s, PLAYER);
  let delayed: Route | undefined;
  await page.route(`**/api/sessions/${s.id}/command`, async (route) => {
    if (route.request().postDataJSON().command.type === 'buzz') {
      delayed = route;
      return;
    }
    return route.fallback();
  });
  await page.goto(`/play/${s.id}`);
  await page.getByRole('button', { name: 'BUZZ!', exact: false }).click();
  await expect.poll(() => !!delayed).toBe(true);
  current().questionId = s.board.questions[1].id;
  current().windowId = crypto.randomUUID();
  current().version++;
  const recovered = page.waitForResponse((r) => r.url().endsWith(`/api/sessions/${s.id}`));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await recovered;
  await settleFrames(page);
  await delayed!.fulfill({
    status: 400,
    json: { error: 'That action is not available at this stage.' },
  });
  await expect(page.getByRole('button', { name: 'BUZZ!', exact: false })).toBeEnabled();
  await expect(page.locator('.session-container > p[role="alert"]')).toBeEmpty();
});

test('editor adds, reorders and saves tiebreaker clues as part of the board JSON', async ({
  page,
}) => {
  const s = fixture();
  await mock(page, s);
  await page.goto(`/host/edit/${s.gameId}`);
  const section = page.locator('.saved-tiebreakers');
  await expect(section).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  for (const name of ['First', 'Second']) {
    await section.getByRole('button', { name: 'Add tiebreaker clue', exact: true }).click();
    const fieldset = section.locator('fieldset').last();
    await fieldset.getByLabel('Category', { exact: true }).fill(name + ' category');
    await fieldset.getByLabel('Clue', { exact: true }).fill(name + ' clue');
    await fieldset.getByLabel('Correct response', { exact: true }).fill(name + ' answer');
  }
  await section
    .locator('fieldset')
    .last()
    .getByRole('button', { name: 'Move up', exact: true })
    .click();
  await expect(
    section.locator('fieldset').first().getByRole('textbox', { name: 'Category', exact: true }),
  ).toHaveValue('Second category');
  const saved = page.waitForRequest(
    (r) => r.url().includes(`/api/games/${s.gameId}`) && r.method() === 'PUT',
  );
  await page.getByRole('button', { name: 'Save board', exact: true }).click();
  expect(
    (await saved).postDataJSON().board.tiebreakers.map((q: { category: string }) => q.category),
  ).toEqual(['Second category', 'First category']);
  await page.getByRole('button', { name: 'Import JSON', exact: true }).click();
  await page.getByRole('button', { name: 'Use current board JSON' }).click();
  const json = JSON.parse(await page.getByLabel('Board JSON', { exact: true }).inputValue());
  expect(json.tiebreakers[0]).toEqual({
    category: 'Second category',
    question: 'Second clue',
    answer: 'Second answer',
  });
});

test('host presents saved clues in order across a reload and gets manual fallback only when exhausted', async ({
  page,
}) => {
  const initial = tiedFinal();
  initial.board.tiebreakers = [
    { category: 'Saved category one', prompt: 'Saved clue one', answer: 'Saved answer one' },
    { category: 'Saved category two', prompt: 'Saved clue two', answer: 'Saved answer two' },
  ];
  const s = applyCommand(
    initial,
    { type: 'finish' },
    {
      userId: HOST,
      controller: CONTROL,
      now: Date.now(),
      expectedVersion: 0,
      actionId: crypto.randomUUID(),
    },
  );
  const current = await mock(page, s);
  await openControlledHost(page, s);
  await expect(page.getByText('Saved category one', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Tiebreaker clue', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Present next saved clue' }).click();
  await expect(page.getByRole('heading', { name: 'Saved clue one', exact: true })).toBeVisible();
  for (const id of [PLAYER, TIED_OTHER]) {
    await simulateBuzz(page, current, id);
    await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Prepare another clue' }).click();
  await page.reload();
  await page.getByLabel('Host PIN').fill('123456');
  await page.getByRole('button', { name: 'Resume / take control' }).click();
  await page.getByRole('button', { name: 'Continue game', exact: false }).first().click();
  await expect(page.getByText('Saved category two', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Present next saved clue' }).click();
  await expect(page.getByRole('heading', { name: 'Saved clue two', exact: true })).toBeVisible();
  expect(current().tiebreaker?.savedCluesUsed).toBe(2);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Reveal without a winner' }).click();
  await page.getByRole('button', { name: 'Prepare another clue' }).click();
  await expect(page.getByRole('button', { name: 'Present next saved clue' })).toHaveCount(0);
  await expect(page.getByLabel('Tiebreaker clue', { exact: true })).toBeVisible();
});

test('previous games retain their session titles after the board is renamed', async ({ page }) => {
  const s = fixture();
  s.phase = 'finished';
  s.title = 'Round 1';
  await mock(page, s);
  await page.route('**/api/games', (route) =>
    route.fulfill({
      json: {
        games: [
          {
            id: s.gameId,
            title: 'Round 3',
            version: 2,
            updatedAt: new Date().toISOString(),
            archived: false,
          },
        ],
        sessions: [
          {
            id: s.id,
            gameId: s.gameId,
            title: 'Round 1',
            joinCode: s.joinCode,
            active: false,
            phase: 'finished',
            players: 2,
            createdAt: new Date().toISOString(),
          },
          {
            id: '77777777-7777-4777-8777-777777777777',
            gameId: s.gameId,
            title: 'Round 2',
            joinCode: '223344',
            active: false,
            phase: 'ended',
            players: 2,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  await page.goto('/host');
  await expect(page.locator('.game-card').getByText('Round 3', { exact: true })).toBeVisible();
  const history = page.locator('.history-list');
  await expect(history.getByText('Round 1', { exact: true })).toBeVisible();
  await expect(history.getByText('Round 2', { exact: true })).toBeVisible();
  await expect(history.getByText('Round 3', { exact: true })).toHaveCount(0);
  await history.getByRole('link').filter({ hasText: 'Round 1' }).click();
  await expect(page.locator('.live-heading h1')).toHaveText('Round 1');
});

declare global {
  interface Window {
    awakeTest: {
      requests: number;
      releases: number;
      hidden: boolean;
      mode: 'ok' | 'deny' | 'pending';
      resolve?: () => void;
      revoke: () => void;
    };
  }
}
async function mockWakeLock(page: Page, mode: 'ok' | 'deny' | 'pending' | 'unsupported' = 'ok') {
  await page.addInitScript(
    ({ mode }) => {
      window.awakeTest = {
        requests: 0,
        releases: 0,
        hidden: false,
        mode: mode === 'unsupported' ? 'ok' : mode,
        revoke: () => {},
      };
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (window.awakeTest.hidden ? 'hidden' : 'visible'),
      });
      class Sentinel extends EventTarget {
        released = false;
        async release() {
          if (!this.released) {
            this.released = true;
            window.awakeTest.releases++;
            this.dispatchEvent(new Event('release'));
          }
        }
      }
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value:
          mode === 'unsupported'
            ? undefined
            : {
                request: async () => {
                  window.awakeTest.requests++;
                  if (window.awakeTest.mode === 'deny') throw new Error('NotAllowedError');
                  const sentinel = new Sentinel();
                  window.awakeTest.revoke = () => {
                    void sentinel.release();
                  };
                  if (window.awakeTest.mode === 'pending')
                    await new Promise<void>((resolve) => {
                      window.awakeTest.resolve = resolve;
                    });
                  return sentinel;
                },
              },
      });
    },
    { mode },
  );
}
test('player wake lock activates, reacquires after visibility changes, and releases when disabled', async ({
  page,
}) => {
  const s = fixture();
  await mock(page, s, PLAYER);
  await mockWakeLock(page);
  await page.goto(`/play/${s.id}`);
  const control = page.getByRole('button', { name: 'Keep screen awake', exact: true });
  await control.click();
  await expect(page.locator('.awake-status')).toHaveText('Active');
  await page.evaluate(() => {
    window.awakeTest.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.awake-status')).toContainText('Waiting');
  await page.evaluate(() => {
    window.awakeTest.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.awake-status')).toHaveText('Active');
  expect(await page.evaluate(() => window.awakeTest.requests)).toBe(2);
  await control.click();
  await expect(page.locator('.awake-status')).toHaveText('Off');
  expect(await page.evaluate(() => window.awakeTest.releases)).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('host wake lock reports OS release and can retry without pausing gameplay', async ({
  page,
}) => {
  const s = fixture();
  const current = await mock(page, s);
  await mockWakeLock(page);
  await openControlledHost(page, s);
  await page.getByRole('button', { name: 'Keep screen awake', exact: true }).click();
  await expect(page.locator('.awake-status')).toHaveText('Active');
  await page.evaluate(() => window.awakeTest.revoke());
  await expect(page.locator('.awake-status')).toContainText('Released by device');
  await page.getByRole('button', { name: 'Keep screen awake', exact: true }).click();
  await expect(page.locator('.awake-status')).toHaveText('Active');
  expect(current().paused).toBe(false);
  await page.getByRole('link', { name: 'Your boards', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.awakeTest.releases)).toBe(2);
});
test('wake lock denial is retryable and unsupported devices get a clear fallback', async ({
  page,
}) => {
  const s = fixture();
  await mock(page, s, PLAYER);
  await mockWakeLock(page, 'deny');
  await page.goto(`/play/${s.id}`);
  await page.getByRole('button', { name: 'Keep screen awake', exact: true }).click();
  await expect(page.locator('.awake-status')).toContainText('Unavailable');
  await page.evaluate(() => {
    window.awakeTest.mode = 'ok';
  });
  await page.getByRole('button', { name: 'Keep screen awake', exact: true }).click();
  await expect(page.locator('.awake-status')).toHaveText('Active');
  await mockWakeLock(page, 'unsupported');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Keep screen awake', exact: true })).toHaveCount(0);
  await expect(page.locator('.awake-status')).toContainText('Extend your device');
});
test('a cancelled pending wake lock is released when the browser eventually grants it', async ({
  page,
}) => {
  const s = fixture();
  await mock(page, s, PLAYER);
  await mockWakeLock(page, 'pending');
  await page.goto(`/play/${s.id}`);
  const control = page.getByRole('button', { name: 'Keep screen awake', exact: true });
  await control.click();
  await expect(page.locator('.awake-status')).toContainText('Requesting');
  await control.click();
  await expect(page.locator('.awake-status')).toHaveText('Off');
  await page.evaluate(() => window.awakeTest.resolve?.());
  await expect.poll(() => page.evaluate(() => window.awakeTest.releases)).toBe(1);
  await expect(page.locator('.awake-status')).toHaveText('Off');
});
test('ending the session releases an active screen wake lock', async ({ page }) => {
  const s = fixture();
  const current = await mock(page, s, PLAYER);
  await mockWakeLock(page);
  await page.goto(`/play/${s.id}`);
  await page.getByRole('button', { name: 'Keep screen awake', exact: true }).click();
  await expect(page.locator('.awake-status')).toHaveText('Active');
  current().phase = 'ended';
  current().version++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Thanks for playing.' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.awakeTest.releases)).toBe(1);
});
function submissionFixture() {
  const s = tiedFinal();
  s.phase = 'finalAnswer';
  s.deadline = Date.now() + 30000;
  s.final[PLAYER] = {
    score: 1000,
    wager: 100,
    text: 'Secret saved response',
    submittedAt: Date.now(),
  };
  s.final[TIED_OTHER] = { score: 1000, wager: 100, text: '', submittedAt: Date.now() };
  s.final[SPECTATOR] = { score: 400, wager: 0, text: '' };
  return s;
}
test('host sees live received, blank and missing Final submissions separately from judging', async ({
  page,
}) => {
  const s = submissionFixture(),
    current = await mock(page, s);
  await openControlledHost(page, s);
  const overview = page.getByRole('region', { name: 'Final response submissions' });
  await expect(overview.getByRole('heading', { name: '1 of 3 responses saved' })).toBeVisible();
  await expect(overview).toContainText('Blank response saved');
  await expect(overview).toContainText('No response received');
  await expect(overview.getByText('Secret saved response', { exact: true })).toHaveCount(0);
  current().final[SPECTATOR].text = 'Another response';
  current().final[SPECTATOR].submittedAt = Date.now();
  current().version++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(overview.getByRole('heading', { name: '2 of 3 responses saved' })).toBeVisible();
  current().phase = 'finalReview';
  current().deadline = undefined;
  current().final[PLAYER].judged = true;
  current().final[PLAYER].correct = false;
  current().version++;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(overview).toContainText('Response saved · Judged incorrect');
  await expect(overview).toContainText('Submissions are locked.');
});
for (const role of ['audience', 'player'] as const) {
  test(`${role} cannot see the host Final submission overview or other private answers`, async ({
    page,
  }) => {
    const s = submissionFixture();
    await mock(page, s, role === 'audience' ? HOST : SPECTATOR);
    await page.goto(role === 'audience' ? `/display/${s.id}` : `/play/${s.id}`);
    await expect(page.locator('.question-stage')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Final response submissions' })).toHaveCount(0);
    await expect(page.getByText('Secret saved response', { exact: true })).toHaveCount(0);
    if (role === 'audience')
      await expect(
        page.getByRole('button', { name: 'Keep screen awake', exact: true }),
      ).toHaveCount(0);
  });
}

test('audience displays the current Final response and wager before judging, then advances privately', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'finalReview';
  s.deadline = undefined;
  s.players.push({ id: TIED_OTHER, name: 'Sam', score: 200, lastSeen: Date.now(), removed: false });
  s.final = {
    [PLAYER]: { score: 100, wager: 25, text: 'Jon wrote this response', submittedAt: Date.now() },
    [TIED_OTHER]: { score: 200, wager: 50, text: 'Next private response' },
  };
  const current = await mock(page, s);
  await page.goto(`/display/${s.id}`);
  await expect(page.getByRole('heading', { name: 'Alex’s moment.', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Jon wrote this response', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Wager: $25', { exact: true })).toBeVisible();
  await expect(page.getByText('Next private response', { exact: true })).toHaveCount(0);
  await expect(page.locator('.host-answer')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Correct', exact: true })).toHaveCount(0);
  const now = current();
  Object.assign(
    now,
    applyCommand(
      now,
      { type: 'finalJudge', playerId: PLAYER, correct: false },
      {
        userId: HOST,
        controller: CONTROL,
        now: Date.now(),
        expectedVersion: now.actionVersion,
        actionId: crypto.randomUUID(),
      },
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Sam’s moment.', exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Next private response', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(s.board.final.answer, { exact: true })).toHaveCount(0);
});

test('mobile session controls use aligned rows without overlap at common phone widths', async ({
  page,
}) => {
  const s = fixture();
  await mock(page, s, PLAYER);
  await mockWakeLock(page);
  await page.goto(`/play/${s.id}`);
  for (const width of [320, 375, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const positions = await page.locator('.session-topline').evaluate((el) => {
      const home = el.querySelector('.back-link')!.getBoundingClientRect();
      const controls = el.querySelector('.session-connection-controls')!.getBoundingClientRect();
      const awake = el.querySelector('.awake-control')!.getBoundingClientRect();
      return {
        homeMid: home.y + home.height / 2,
        controlsMid: controls.y + controls.height / 2,
        controlsBottom: controls.bottom,
        awakeTop: awake.top,
        awakeRight: awake.right,
        scroll: document.documentElement.scrollWidth,
        viewport: innerWidth,
      };
    });
    expect(Math.abs(positions.homeMid - positions.controlsMid)).toBeLessThan(3);
    expect(positions.awakeTop).toBeGreaterThanOrEqual(positions.controlsBottom);
    expect(positions.awakeRight).toBeLessThanOrEqual(width);
    expect(positions.scroll).toBeLessThanOrEqual(positions.viewport);
  }
  await page.getByRole('button', { name: 'Keep screen awake', exact: true }).click();
  await expect(page.locator('.awake-status')).toHaveText('Active');
  await page.getByRole('button', { name: 'Enable sound', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute sound', exact: true })).toBeVisible();
});

test('Final correct-response stage appears before the host opens individual responses', async ({
  page,
}) => {
  const s = submissionFixture();
  s.phase = 'finalReveal';
  s.deadline = undefined;
  const current = await mock(page, s);
  await openControlledHost(page, s);
  await expect(
    page
      .locator('.final-solution')
      .getByRole('heading', { name: s.board.final.answer, exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Secret saved response', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Correct', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reveal player responses', exact: false }).click();
  expect(current().phase).toBe('finalReview');
  await expect(page.getByRole('heading', { name: 'Pat’s moment.', exact: true })).toBeVisible();
});
test('audience correct-response stage does not expose private player responses or host controls', async ({
  page,
}) => {
  const s = submissionFixture();
  s.phase = 'finalReveal';
  s.deadline = undefined;
  await mock(page, s);
  await page.goto(`/display/${s.id}`);
  await expect(
    page.getByRole('heading', { name: s.board.final.answer, exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Secret saved response', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Reveal player responses', exact: false }),
  ).toHaveCount(0);
});
for (const tied of [false, true]) {
  test(`final results show only the ${tied ? 'winning tiebreaker' : 'Final Jeopardy'} answer`, async ({
    page,
  }) => {
    const s = finalFixture();
    if (tied)
      s.tiebreaker = {
        playerIds: [PLAYER],
        winnerId: PLAYER,
        rounds: [
          {
            id: crypto.randomUUID(),
            category: 'Capitals',
            prompt: 'Capital of Canada?',
            answer: 'What is Ottawa?',
            attempts: [],
            outcome: 'correct',
            winnerId: PLAYER,
          },
        ],
      };
    await mock(page, s, PLAYER);
    await page.goto(`/play/${s.id}`);
    await expect(page.getByRole('heading', { name: 'Alex wins!', exact: true })).toBeVisible();
    const blocks = page.locator('.celebration > .answer-reveal');
    await expect(blocks).toHaveCount(1);
    await expect(blocks).toContainText(tied ? 'What is Ottawa?' : s.board.final.answer);
    if (tied) {
      await expect(blocks).not.toContainText(s.board.final.answer);
      await expect(blocks).not.toContainText('Capital of Canada?');
    }
  });
}
test('player Final layout scales with card width across phones, tablets and laptops', async ({
  page,
}) => {
  const s = submissionFixture();
  s.deadline = Date.now() + 60000;
  await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  for (const width of [320, 390, 768, 1366, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const sizes = await page.locator('.player-container').evaluate((el) => {
      const card = el.querySelector('.final-stage')!.getBoundingClientRect();
      const timer = el.querySelector('.final-stage .timer')!.getBoundingClientRect();
      const title = el.querySelector('.final-stage > h2')!;
      const category = el.querySelector('.final-stage .eyebrow')!.getBoundingClientRect();
      return {
        width: el.getBoundingClientRect().width,
        font: parseFloat(getComputedStyle(title).fontSize),
        left: card.left,
        right: card.right,
        timerLeft: timer.left,
        timerRight: timer.right,
        categoryRight: category.right,
        scroll: document.documentElement.scrollWidth,
      };
    });
    expect(sizes.timerRight).toBeLessThanOrEqual(sizes.right);
    expect(sizes.categoryRight).toBeLessThanOrEqual(sizes.timerLeft);
    expect(sizes.scroll).toBeLessThanOrEqual(width);
    expect(sizes.font).toBeLessThanOrEqual(36);
    if (width >= 1366) expect(sizes.width).toBeGreaterThan(700);
  }
  await page.getByRole('textbox', { name: 'Your response', exact: true }).fill('Taj Mahal');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.locator('.player-game form [role="status"]')).toHaveText('Saved');
});

test('next selection persists across misses, correct responses, undo and reload while host selects tiles', async ({
  page,
}) => {
  let s = fixture();
  s.phase = 'board';
  s.nextSelectorId = PLAYER;
  const other = '55555555-5555-4555-8555-555555555555';
  s.players.push({ id: other, name: 'Jon', score: 0, lastSeen: Date.now(), removed: false });
  const current = await mock(page, s);
  await page.goto(`/host/session/${s.id}`);
  await page.getByLabel('Host PIN', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Resume / take control' }).click();
  await page.getByRole('button', { name: 'Continue game', exact: false }).first().click();
  await expect(page.getByText('Next selection: Alex', { exact: true })).toBeVisible();
  await page.locator('.board-tile').first().click();
  // This fixture's first tile is regular; submit another player's buzz through the real engine.
  const buzz = () => {
    const state = current();
    const next = applyCommand(
      state,
      { type: 'buzz', windowId: state.windowId! },
      {
        userId: other,
        now: Date.now(),
        actionId: crypto.randomUUID(),
        expectedVersion: state.actionVersion,
      },
    );
    Object.assign(state, next);
  };
  buzz();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  await expect(page.getByText('Next selection: Alex', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo last judgment', exact: true }).click();
  await page.getByRole('button', { name: 'Correct', exact: true }).click();
  await expect(page.getByText('Next selection: Jon', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Next selection: Jon', { exact: true })).toBeVisible();
  expect(current().nextSelectorId).toBe(other);
  const box = await page.locator('.selection-indicator').boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
});

for (const role of ['player', 'audience'] as const) {
  test(`${role} sees selection without host tile controls`, async ({ page }) => {
    const s = fixture();
    s.phase = 'board';
    s.nextSelectorId = PLAYER;
    await mock(page, s, role === 'player' ? PLAYER : HOST);
    await page.goto(`/${role === 'player' ? 'play' : 'display'}/${s.id}`);
    await expect(page.getByText('Next selection: Alex', { exact: true })).toBeVisible();
    if (role === 'player')
      await expect(
        page.getByText('Your choice — tell the host the category and value.'),
      ).toBeVisible();
    await expect(page.locator('.board-tile:not([disabled])')).toHaveCount(0);
  });
}

test('host can undo every judgment for one clue across reloads but cannot cross into another clue', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'board';
  s.nextSelectorId = PLAYER;
  s.players.push({ id: TIED_OTHER, name: 'Sam', score: 0, lastSeen: Date.now(), removed: false });
  const current = await mock(page, s);
  await claimHost(page, s);
  await page.locator('.board-tile').first().click();
  await simulateBuzz(page, current, PLAYER);
  await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  await simulateBuzz(page, current, TIED_OTHER);
  await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  await expect(page.getByText(/2 judgments can be undone for this clue/)).toBeVisible();
  expect(current().players.map((p) => p.score)).toEqual([-200, -200]);
  await page.getByRole('button', { name: 'Undo last judgment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Clue hidden while Sam answers' })).toBeVisible();
  await expect(page.getByText(/1 judgment can be undone for this clue/)).toBeVisible();
  expect(current().players.map((p) => p.score)).toEqual([-200, 0]);
  await page.reload();
  await page.getByLabel('Host PIN').fill('123456');
  await page.getByRole('button', { name: 'Resume / take control' }).click();
  await page.getByRole('button', { name: 'Continue game', exact: false }).first().click();
  await page.getByRole('button', { name: 'Undo last judgment', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Clue hidden while Alex answers' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo last judgment', exact: true })).toHaveCount(
    0,
  );
  expect(current().players.map((p) => p.score)).toEqual([0, 0]);
  expect(current().events).toHaveLength(0);
  await page.getByRole('button', { name: 'Correct', exact: true }).click();
  await expect(page.getByText(/1 judgment can be undone for this clue/)).toBeVisible();
  await page.getByRole('button', { name: 'Back to the board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Undo last judgment', exact: true })).toHaveCount(
    0,
  );
  await page.locator('.board-tile:not([disabled])').first().click();
  await expect(page.getByRole('button', { name: 'Undo last judgment', exact: true })).toHaveCount(
    0,
  );
  expect(current().players.map((p) => p.score)).toEqual([200, 0]);
});

function pendingDaily() {
  let s = fixture();
  s.phase = 'board';
  s.nextSelectorId = PLAYER;
  s.players[0].score = 500;
  return applyCommand(
    s,
    { type: 'select', questionId: s.board.questions.find((q) => q.dailyDouble)!.id },
    {
      userId: HOST,
      controller: CONTROL,
      now: Date.now(),
      actionId: crypto.randomUUID(),
      expectedVersion: s.actionVersion,
    },
  );
}

test('Daily Double finder saves and edits a wager on their own screen before the host reveals the clue', async ({
  page,
}) => {
  const s = pendingDaily();
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.getByRole('heading', { name: 'Alex found the Daily Double!' })).toBeVisible();
  const input = page.getByRole('spinbutton', { name: 'Your wager · max $500', exact: true });
  await input.fill('501');
  await expect(page.getByRole('button', { name: 'Save wager', exact: true })).toBeDisabled();
  await input.fill('200');
  await page.getByRole('button', { name: 'Save wager', exact: true }).click();
  await expect(page.getByText('Saved wager: $200', { exact: true })).toBeVisible();
  expect(current().phase).toBe('dailyWager');
  await expect(page.getByRole('button', { name: 'Lock wager & reveal clue' })).toHaveCount(0);
  await page.reload();
  await expect(input).toHaveValue('200');
  await input.fill('350');
  await page.getByRole('button', { name: 'Save wager', exact: true }).click();
  await expect(page.getByText('Saved wager: $350', { exact: true })).toBeVisible();
  await page.screenshot({
    path: `/tmp/daily-wager-${await page.evaluate(() => innerWidth)}.png`,
    fullPage: true,
  });
  const state = current();
  Object.assign(
    state,
    applyCommand(
      state,
      { type: 'openDaily' },
      {
        userId: HOST,
        controller: CONTROL,
        now: Date.now(),
        actionId: crypto.randomUUID(),
        expectedVersion: state.actionVersion,
      },
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('heading', {
      name: s.board.questions.find((q) => q.dailyDouble)!.prompt,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  await expect(page.locator('.buzzer')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('host sees the assigned finder and saved Daily Double wager and locks it without selecting a player', async ({
  page,
}) => {
  const s = pendingDaily();
  const current = await mock(page, s);
  await claimHost(page, s);
  await expect(page.getByRole('heading', { name: 'Alex found the Daily Double!' })).toBeVisible();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  const lock = page.getByRole('button', { name: 'Lock wager & reveal clue', exact: true });
  await expect(lock).toBeDisabled();
  const state = current();
  Object.assign(
    state,
    applyCommand(
      state,
      { type: 'dailyWager', amount: 200 },
      {
        userId: PLAYER,
        now: Date.now(),
        actionId: crypto.randomUUID(),
        expectedVersion: state.actionVersion,
      },
    ),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Saved wager: $200', { exact: true })).toBeVisible();
  await lock.click();
  await expect(
    page.getByRole('heading', {
      name: s.board.questions.find((q) => q.dailyDouble)!.prompt,
      exact: true,
    }),
  ).toBeVisible();
  expect(current().daily?.playerId).toBe(PLAYER);
  await page.getByRole('button', { name: 'Incorrect', exact: true }).click();
  expect(current().players[0].score).toBe(300);
  await page.getByRole('button', { name: 'Undo last judgment', exact: true }).click();
  expect(current().daily?.amount).toBe(200);
  expect(current().players[0].score).toBe(500);
  expect(current().phase).toBe('dailyAnswer');
});

for (const role of ['other player', 'audience'] as const) {
  test(`${role} sees the saved Daily Double wager without wager or reveal controls`, async ({
    page,
  }) => {
    const s = pendingDaily();
    s.daily = { playerId: PLAYER, amount: 250, submitted: true };
    s.players.push({ id: TIED_OTHER, name: 'Sam', score: 0, lastSeen: Date.now(), removed: false });
    await mock(page, s, role === 'audience' ? HOST : TIED_OTHER);
    await page.goto(`/${role === 'audience' ? 'display' : 'play'}/${s.id}`);
    await expect(page.getByText('Saved wager: $250', { exact: true })).toBeVisible();
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save wager', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Lock wager & reveal clue' })).toHaveCount(0);
    await expect(
      page.getByRole('heading', {
        name: s.board.questions.find((q) => q.dailyDouble)!.prompt,
        exact: true,
      }),
    ).toHaveCount(0);
  });
}

test('Final save receipts preserve game state and do not regress revisions after an older snapshot', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'finalAnswer';
  s.deadline = Date.now() + 30000;
  s.final = { [PLAYER]: { score: 0, wager: 0, text: '' } };
  const stale = structuredClone(s);
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  const response = page.getByRole('textbox', { name: 'Your response', exact: true });
  await response.fill('First response');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await response.fill('Second response');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect.poll(() => current().final[PLAYER].revision).toBe(2);
  expect(current().version).toBe(0);
  let served = false;
  await page.route(`**/api/sessions/${s.id}`, async (route) => {
    served = true;
    await route.fulfill({ json: viewSession(stale, PLAYER, Date.now()) });
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => served).toBe(true);
  await page.waitForTimeout(150);
  await response.fill('Third response');
  await page.getByRole('button', { name: 'Save response', exact: true }).click();
  await expect.poll(() => current().final[PLAYER].revision).toBe(3);
  expect(current().final[PLAYER].text).toBe('Third response');
  expect(current().version).toBe(0);
});

test('a focus burst allows one snapshot request in flight and one trailing refresh', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'board';
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(page.getByText('Next selection: Alex', { exact: true })).toBeVisible();
  let active = 0,
    peak = 0,
    calls = 0;
  await page.route(`**/api/sessions/${s.id}`, async (route) => {
    active++;
    calls++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 180));
    await route.fulfill({ json: viewSession(current(), PLAYER, Date.now()) });
    active--;
  });
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) window.dispatchEvent(new Event('focus'));
  });
  await page.waitForTimeout(700);
  expect(peak).toBe(1);
  expect(calls).toBeLessThanOrEqual(2);
  expect(calls).toBeGreaterThan(0);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
});

test('brief host uncertainty shows saved-progress recovery and clears on a fresh presence snapshot', async ({
  page,
}) => {
  const s = fixture();
  s.phase = 'board';
  s.hostSeen = Date.now() - 12000;
  const current = await mock(page, s, PLAYER);
  await page.goto(`/play/${s.id}`);
  await expect(
    page.getByText('Reconnecting to host — your progress is saved.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Host is not online', { exact: true })).toHaveCount(0);
  current().hostSeen = Date.now();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByText('Reconnecting to host — your progress is saved.', { exact: true }),
  ).toHaveCount(0);
  await expect(page.locator('.personal-score strong')).toHaveText('$0');
  expect(current().version).toBe(0);
});
