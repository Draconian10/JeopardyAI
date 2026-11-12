import { test, expect } from '@playwright/test';

const host = {
  id: '11111111-1111-4111-8111-111111111111',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'host@example.com',
  is_anonymous: false,
  app_metadata: {},
  user_metadata: {},
  created_at: new Date().toISOString(),
};

test('new host sees email confirmation instructions and a public return link', async ({ page }) => {
  let redirect = '';
  await page.route('https://example.supabase.co/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/signup')) {
      redirect = url.searchParams.get('redirect_to') || '';
      await route.fulfill({ json: { user: host, session: null } });
    } else {
      await route.fulfill({ json: host });
    }
  });

  await page.goto('/host');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Email').fill('newhost@example.com');
  await page.getByLabel('Password').fill('a-unique-test-password');
  await page.getByRole('button', { name: 'Create account' }).click();

  await expect(page.getByRole('heading', { name: 'Check your inbox.' })).toBeVisible();
  await expect(page.getByText('newhost@example.com')).toBeVisible();
  expect(redirect).toBe('http://127.0.0.1:3000/host?confirmed=1');
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
});

test('signing out of the host account uses the local scope', async ({ page }) => {
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: host.id, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}.test`;
  await page.addInitScript(
    ({ token, host }) => {
      localStorage.setItem(
        'sb-example-auth-token',
        JSON.stringify({
          access_token: token,
          refresh_token: 'test',
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          token_type: 'bearer',
          user: host,
        }),
      );
    },
    { token, host },
  );
  let signedOutScope = '';
  await page.route('https://example.supabase.co/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/logout')) {
      signedOutScope = url.searchParams.get('scope') || '';
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ json: host });
  });
  await page.route('**/api/games', (route) => route.fulfill({ json: { games: [], sessions: [] } }));

  await page.goto('/host');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect(signedOutScope).toBe('local');
});
