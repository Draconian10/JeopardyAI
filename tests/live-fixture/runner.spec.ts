import { writeFile } from 'node:fs/promises';
import { test, expect, type BrowserContext } from '@playwright/test';
import { applyCommand, createSession, reconcile, viewSession } from '../../lib/game/engine';
import { resultsCsv } from '../../lib/game/results-csv';
import type { Session } from '../../lib/game/types';
import type { Board } from '../../lib/game/schema';
import { runLiveGame } from '../../scripts/live-game.mjs';
const HOST = crypto.randomUUID();
test('live runner drives independent browser profiles through a full game (offline backend fixture)', async ({
  browser,
}) => {
  let s: Session | undefined,
    board: Board | undefined,
    boardId = '',
    pin = '';
  async function configureContext(
    context: BrowserContext,
    { role, index }: { role: string; index?: number },
  ) {
    const id = role === 'host' ? HOST : crypto.randomUUID();
    const user = {
      id,
      aud: 'authenticated',
      role: 'authenticated',
      email: role === 'host' ? 'test-host@example.com' : undefined,
      is_anonymous: role !== 'host',
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    };
    const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: id, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture`;
    await context.addInitScript(
      ({ token, user }) => {
        localStorage.setItem(
          'sb-example-auth-token',
          JSON.stringify({
            access_token: token,
            refresh_token: 'fixture',
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            token_type: 'bearer',
            user,
          }),
        );
        // Fixture only: accelerate fallback polling, not game deadlines or host leases.
        const native = window.setTimeout.bind(window);
        window.setTimeout = ((handler: TimerHandler, ms?: number, ...args: unknown[]) =>
          native(
            handler,
            ms !== undefined && ((ms >= 3000 && ms <= 3300) || (ms >= 10000 && ms <= 10300))
              ? 500
              : ms,
            ...args,
          )) as typeof window.setTimeout;
      },
      { token, user },
    );
    await context.route('https://example.supabase.co/auth/v1/**', (route) =>
      route.fulfill({ json: user }),
    );
    await context.routeWebSocket(/example\.supabase\.co/, (socket) => socket.close());
    await context.route('**/api/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        parts = url.pathname.split('/').filter(Boolean).slice(1);
      const [resource, target, op] = parts;
      try {
        if (resource === 'player-sessions') return route.fulfill({ json: { sessions: [] } });
        if (resource === 'games' && !target && request.method() === 'GET')
          return route.fulfill({ json: { games: [], sessions: [] } });
        if (resource === 'games' && !target && request.method() === 'POST') {
          const body = request.postDataJSON();
          board = body.board;
          pin = body.pin;
          boardId = crypto.randomUUID();
          return route.fulfill({ status: 201, json: { id: boardId } });
        }
        if (resource === 'games' && op === 'start') {
          const body = request.postDataJSON();
          s = createSession(board!, boardId, HOST, '183944', Date.now(), body.controller);
          s.id = body.requestId;
          return route.fulfill({ status: 201, json: { id: s.id } });
        }
        if (resource === 'games' && op === 'archive')
          return route.fulfill({ json: { id: boardId } });
        if (!s) throw new Error('No session');
        const controller = request.headers()['x-controller'];
        if (resource === 'join') {
          const body = request.postDataJSON();
          s = applyCommand(
            s,
            { type: 'join', name: body.name },
            { userId: id, now: Date.now(), actionId: crypto.randomUUID(), expectedVersion: 0 },
          );
          return route.fulfill({ json: { id: s.id } });
        }
        if (resource === 'sessions' && op === 'results')
          return route.fulfill({
            contentType: 'text/csv',
            body: resultsCsv(s),
          });
        if (resource === 'sessions' && op === 'end') {
          s.phase = 'ended';
          return route.fulfill({ json: { ended: true } });
        }
        if (resource === 'sessions' && op === 'command') {
          const body = request.postDataJSON();
          if (body.command.type === 'heartbeat') {
            if (id === HOST && body.controller !== s.controller)
              return route.fulfill({ status: 409, json: { error: 'Another controller' } });
            if (id === HOST) s.hostSeen = Date.now();
            else {
              const p = s.players.find((p) => p.id === id);
              if (p) p.lastSeen = Date.now();
            }
            return route.fulfill({
              json: { kind: 'heartbeat', serverNow: Date.now(), host: id === HOST },
            });
          }
          const next = applyCommand(s, body.command, {
            userId: id,
            now: Date.now(),
            controller: body.controller,
            actionId: body.actionId,
            expectedVersion: body.version,
            pinVerified: body.command.type === 'claim' && body.command.pin === pin,
          });
          if (body.command.type === 'answer') {
            s.final[id] = next.final[id];
            const entry = s.final[id];
            return route.fulfill({
              json: {
                kind: 'answer',
                serverNow: Date.now(),
                text: entry.text,
                revision: entry.revision,
                submittedAt: entry.submittedAt,
              },
            });
          }
          s = next;
          return route.fulfill({ json: viewSession(s, id, Date.now(), body.controller) });
        }
        if (resource === 'sessions' && request.method() === 'GET') {
          reconcile(s, Date.now());
          return route.fulfill({
            json: viewSession(
              s,
              id,
              Date.now(),
              controller,
              url.searchParams.get('view') === 'audience',
            ),
          });
        }
        throw new Error('Unexpected fixture route');
      } catch (error) {
        return route.fulfill({
          status: (error as { status?: number }).status ?? 409,
          json: { error: (error as Error).message },
        });
      }
    });
  }
  const context = await browser.newContext();
  await configureContext(context, { role: 'host' });
  const page = await context.newPage();
  await page.goto('/host');
  await expect(page.getByRole('heading', { name: /Your boards/ })).toBeVisible();
  const progress = setInterval(
    () =>
      console.log(
        JSON.stringify({
          fixturePhase: s?.phase,
          paused: s?.paused,
          wagersSaved: Object.values(s?.final ?? {}).filter((entry) => entry.wager !== undefined)
            .length,
          responsesSaved: Object.values(s?.final ?? {}).filter((entry) => entry.text.trim()).length,
        }),
      ),
    15000,
  );
  const report = await runLiveGame({
    browser,
    hostPage: page,
    url: 'http://127.0.0.1:3000',
    players: Number(process.env.LIVE_FIXTURE_PLAYERS ?? 3),
    ending: process.env.LIVE_FIXTURE_ENDING ?? 'tie',
    allowPolling: true,
    configureContext,
    onStep: (step: string) => console.log(step),
  });
  clearInterval(progress);
  const reportPath = test.info().outputPath('offline-runner-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  await test
    .info()
    .attach('offline-runner-report', { path: reportPath, contentType: 'application/json' });
  expect(report.error).toBeUndefined();
  expect(report.outcome).toBe('passed');
  expect(report.cleanup.boardArchived).toBe(true);
  await context.close();
});
