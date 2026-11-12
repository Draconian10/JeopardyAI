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

test('forgot password requests a link to the public host reset screen', async ({ page }) => {
  let redirect = '';
  await page.route('https://example.supabase.co/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/recover')) {
      redirect = url.searchParams.get('redirect_to') || '';
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: host });
  });
  await page.goto('/host');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Email').fill('host@example.com');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('If an account exists for this address')).toBeVisible();
  expect(redirect).toBe('http://127.0.0.1:3000/host?reset=1');
});

test('confirmation-pending hosts can request another verification email', async ({ page }) => {
  let resent = false;
  await page.route('https://example.supabase.co/auth/v1/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith('/signup')) return route.fulfill({ json: { user: host, session: null } });
    if (pathname.endsWith('/resend')) {
      resent = true;
      return route.fulfill({ json: {} });
    }
    return route.fulfill({ json: host });
  });
  await page.goto('/host');
  await page.getByRole('button', { name: 'New here? Create an account' }).click();
  await page.getByLabel('Email').fill('host@example.com');
  await page.getByLabel('Password').fill('secure-password-123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Check your inbox.' })).toBeVisible();
  await page.getByRole('button', { name: 'Resend confirmation email' }).click();
  await expect.poll(() => resent).toBe(true);
});

test('signup and forgot-password links stay visibly separated at desktop and mobile widths', async ({
  page,
}) => {
  await page.goto('/host');
  const signup = page.getByRole('button', { name: 'New here? Create an account' });
  const forgot = page.getByRole('button', { name: 'Forgot password?' });
  await expect(signup).toBeVisible();
  await expect(forgot).toBeVisible();
  const a = await signup.boundingBox();
  const b = await forgot.boundingBox();
  expect(a).not.toBeNull();
  expect(b).not.toBeNull();
  expect(b!.x >= a!.x + a!.width + 12 || b!.y >= a!.y + a!.height + 6).toBe(true);
  await forgot.click();
  await expect(page.getByRole('button', { name: 'Send reset link' })).toBeVisible();
});

test('account recovery replaces the password and returns to login', async ({ page }) => {
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: host.id, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}.test`;
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
    { token, user: host },
  );
  let updatedPassword = '';
  let signoutScope = '';
  await page.route('https://example.supabase.co/auth/v1/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/user') && route.request().method() === 'PUT') {
      updatedPassword = route.request().postDataJSON().password;
      return route.fulfill({ json: { user: host } });
    }
    if (url.pathname.endsWith('/logout')) {
      signoutScope = url.searchParams.get('scope') ?? '';
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ json: host });
  });
  await page.goto('/host?reset=1');
  await expect(page.getByRole('heading', { name: 'Choose a new password.' })).toBeVisible();
  await page.getByLabel('New password').fill('new-strong-password');
  await page.getByLabel('Confirm new password').fill('new-strong-password');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByText('Password updated. Sign in to continue.')).toBeVisible();
  expect(updatedPassword).toBe('new-strong-password');
  expect(signoutScope).toBe('local');
  await expect(page).toHaveURL(/\/host$/);
});

test('initial authentication outage has a usable Retry sign-in action', async ({ page }) => {
  const token = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: host.id, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url')}.test`;
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
    { token, user: host },
  );
  let attempts = 0;
  await page.route('https://example.supabase.co/auth/v1/**', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/user')) {
      attempts++;
      if (attempts === 1)
        return route.fulfill({
          status: 503,
          json: { code: 'service_unavailable', msg: 'Temporary service outage' },
        });
    }
    return route.fulfill({ json: host });
  });
  await page.goto('/host');
  await expect(page.getByRole('heading', { name: 'Unable to connect.' })).toBeVisible();
  await page.getByRole('button', { name: 'Retry sign-in' }).click();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  expect(attempts).toBeGreaterThanOrEqual(2);
});
