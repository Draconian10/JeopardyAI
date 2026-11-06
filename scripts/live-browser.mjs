import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runLiveGame } from './live-game.mjs';
export function parseOptions(args) {
  const options = {
    players: 15,
    ending: 'tie',
    headless: false,
    allowPolling: false,
    output: 'test-results/live-browser',
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--url') options.url = args[++i];
    else if (arg === '--players') options.players = Number(args[++i]);
    else if (arg === '--ending') options.ending = args[++i];
    else if (arg === '--output') options.output = args[++i];
    else if (arg === '--headless') options.headless = true;
    else if (arg === '--allow-polling') options.allowPolling = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.url) throw new Error('Provide --url https://your-staging-deployment.');
  const url = new URL(options.url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    !['https:', 'http:'].includes(url.protocol)
  )
    throw new Error('Use an HTTP(S) origin without credentials, path or query.');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))
    throw new Error('Remote tests require HTTPS.');
  if (!Number.isInteger(options.players) || options.players < 2 || options.players > 15)
    throw new Error('Choose 2–15 players.');
  if (!['tie', 'normal'].includes(options.ending))
    throw new Error('Choose --ending tie or normal.');
  return { ...options, url: url.origin };
}
async function main() {
  if (process.argv.includes('--help')) {
    console.log(
      'npm run test:live -- --url https://your-staging-deployment [--players 15] [--ending tie|normal] [--headless] [--allow-polling] [--output test-results/live-browser]',
    );
    return;
  }
  const options = parseOptions(process.argv.slice(2));
  if (options.headless && (!process.env.LIVE_HOST_EMAIL || !process.env.LIVE_HOST_PASSWORD))
    throw new Error(
      '--headless requires LIVE_HOST_EMAIL and LIVE_HOST_PASSWORD for a dedicated test host.',
    );
  const launchOptions = {
    headless: options.headless,
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
    ],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {}),
  };
  let browser = await chromium.launch(launchOptions);
  try {
    let context = await browser.newContext(),
      page = await context.newPage();
    await page.goto(`${options.url}/host`);
    if (options.headless) {
      await page.getByLabel('Email', { exact: true }).fill(process.env.LIVE_HOST_EMAIL);
      await page.getByLabel('Password', { exact: true }).fill(process.env.LIVE_HOST_PASSWORD);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    } else
      console.log(
        'Sign in to the dedicated test host account in the opened browser. No passwords or auth state will be saved to disk.',
      );
    await page.getByRole('heading', { name: /Your boards/ }).waitFor({ timeout: 300000 });
    if (!options.headless) {
      const storageState = await context.storageState();
      await browser.close();
      browser = await chromium.launch({ ...launchOptions, headless: true });
      context = await browser.newContext({ storageState });
      page = await context.newPage();
      await page.goto(`${options.url}/host`);
    }
    console.log(
      `Testing ${options.players} isolated players against ${options.url}. This creates a dedicated board/session and guest Auth identities.`,
    );
    const report = await runLiveGame({ browser, hostPage: page, ...options });
    await mkdir(options.output, { recursive: true });
    await writeFile(
      resolve(options.output, 'report.json'),
      JSON.stringify(report, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log(`Result: ${report.outcome}. Report: ${resolve(options.output, 'report.json')}`);
    if (report.cleanup.error)
      console.warn(
        'The isolated test session/board needs manual cleanup. See the report and host dashboard.',
      );
    if (report.outcome !== 'passed') {
      console.error('The live game did not pass; inspect the report.');
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(() => {
    console.error(
      'Live test could not start or finish. Check the target URL, host sign-in, anonymous Auth settings and browser installation.',
    );
    process.exitCode = 1;
  });
