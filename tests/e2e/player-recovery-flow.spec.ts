import { test, expect } from '@playwright/test';

test('lost-seat player submits a recovery code, waits for approval, then reconnects', async ({
  page,
}) => {
  const playerId = '55555555-5555-4555-8555-555555555555';
  const sessionId = '66666666-6666-4666-8666-666666666666';
  const requestId = '77777777-7777-4777-8777-777777777777';
  const user = {
    id: playerId,
    aud: 'authenticated',
    role: 'authenticated',
    is_anonymous: true,
    app_metadata: {},
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
  const accessToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: playerId, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}.test`;

  let issuedGuest = 0;
  await page.route('https://example.supabase.co/auth/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/signup')) {
      issuedGuest++;
      return route.fulfill({
        json: {
          access_token: accessToken,
          refresh_token: 'test',
          expires_in: 3600,
          token_type: 'bearer',
          user,
        },
      });
    }
    return route.fulfill({ json: user });
  });
  let captured: { code?: string; recoveryCode?: string } = {};
  let recovered = false;
  await page.route('**/api/recovery/request', (route) => {
    captured = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: { requestId } });
  });
  await page.route(`**/api/recovery/${requestId}`, (route) =>
    route.fulfill({
      json: recovered ? { status: 'approved', sessionId } : { status: 'pending' },
    }),
  );
  await page.route('**/api/player-sessions', (route) => route.fulfill({ json: { sessions: [] } }));
  await page.goto('/join');
  await page.getByRole('button', { name: 'Lost your place? Recover your player seat' }).click();
  await page.getByLabel('Six-digit game code').fill('123456');
  await page.getByLabel('Private recovery code').fill('R'.repeat(24));
  await page.getByRole('button', { name: 'Request host approval' }).click();
  await expect(
    page.getByText('Waiting for the host to approve your recovery request.'),
  ).toBeVisible();
  expect(captured).toEqual({ code: '123456', recoveryCode: 'R'.repeat(24) });
  expect(issuedGuest).toBe(1);
  recovered = true;
  await expect(page).toHaveURL(new RegExp(`/play/${sessionId}$`), { timeout: 12000 });
});
