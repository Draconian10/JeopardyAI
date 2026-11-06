import assert from 'node:assert/strict';
import { randomUUID, randomInt } from 'node:crypto';
import { expect } from '@playwright/test';

export function makeTestBoard(title) {
  return {
    title,
    categories: Array.from({ length: 6 }, (_, i) => `Test category ${i + 1}`),
    rows: 5,
    questions: Array.from({ length: 30 }, (_, i) => ({
      id: randomUUID(),
      category: i % 6,
      row: Math.floor(i / 6),
      value: (Math.floor(i / 6) + 1) * 200,
      prompt: `Automated clue ${i + 1}: give the controlled test response.`,
      answer: 'Controlled test response',
      notes: '',
      dailyDouble: i === 11,
    })),
    final: {
      category: 'Automated Final',
      prompt: 'Write a controlled test response.',
      answer: 'Controlled Final response',
    },
    tiebreakers: [1, 2].map((i) => ({
      category: `Automated sudden death ${i}`,
      prompt: `Controlled tiebreaker clue ${i}`,
      answer: `Controlled tiebreaker response ${i}`,
    })),
  };
}

/** A real-browser runner. configureContext exists only for the offline regression fixture. */
export async function runLiveGame({
  browser,
  hostPage,
  url,
  players = 15,
  ending = 'tie',
  allowPolling = false,
  configureContext,
  onStep = console.log,
}) {
  assert(Number.isInteger(players) && players >= 2 && players <= 15, 'Choose 2–15 players.');
  assert(['tie', 'normal'].includes(ending));
  /** @type {{scope:string,targetOrigin:string,transportFixture:boolean,players:number,ending:string,startedAt:string,finishedAt?:string,outcome?:string,error?:string,sessionId?:string,checks:string[],requests:Array<{actor:string,path:string,status:number,ms:number}>,finalReceipts:Record<string,{text:string,revision:number}>,realtimeRequired:boolean,transports?:Array<{actor:string,transport:string|null}>,cleanup:{sessionEnded?:boolean,boardArchived?:boolean,error?:string},unexpectedServerErrors?:number,boardId?:string,durationSeconds?:number,requestLatencyMs?:{p50:number,p95:number,max:number}} */
  const report = {
    scope: configureContext
      ? 'Offline fixture: actual browser UI/game engine, injected emulated Auth/API/Realtime transport and accelerated polling. Not a deployed-cloud test.'
      : 'Real deployment browser UI gameplay; setup/readback/cleanup use authenticated APIs. Background timer throttling is disabled for load testing. This does not simulate physical-phone power management or venue Wi-Fi.',
    targetOrigin: url,
    transportFixture: !!configureContext,
    players,
    ending,
    startedAt: new Date().toISOString(),
    checks: [],
    requests: [],
    finalReceipts: {},
    realtimeRequired: !allowPolling,
    cleanup: {},
  };
  const contexts = [],
    actors = [],
    receiptTasks = new Set();
  const host = { name: 'Host', page: hostPage, context: hostPage.context(), controller: undefined };
  let sessionId, boardId, joinCode;
  const pin = String(randomInt(100000, 1000000));
  function observe(actor) {
    actor.page.on('request', (request) => {
      if (
        actor !== host ||
        !request.url().includes('/api/sessions/') ||
        request.method() !== 'POST'
      )
        return;
      try {
        const body = request.postDataJSON();
        if (body?.controller) actor.controller = body.controller;
      } catch {
        /* No body metadata needed. */
      }
    });
    actor.page.on('response', (response) => {
      const parsed = new URL(response.url());
      if (parsed.origin !== new URL(url).origin || !parsed.pathname.startsWith('/api/')) return;
      const task = (async () => {
        await response.finished();
        const timing = response.request().timing();
        report.requests.push({
          actor: actor.name,
          path: parsed.pathname.replace(/[0-9a-f-]{36}/gi, ':id'),
          status: response.status(),
          ms: Math.max(0, Math.round(timing.responseEnd)),
        });
        try {
          const body = response.request().postDataJSON();
          if (body?.command?.type === 'buzz') {
            actor.buzzes ??= [];
            actor.buzzes.push({ windowId: body.command.windowId, status: response.status() });
          }
          if (actor !== host && body?.command?.type === 'answer' && response.ok()) {
            const receipt = await response.json();
            if (
              receipt.kind === 'answer' &&
              receipt.revision >= (report.finalReceipts[actor.name]?.revision ?? 0)
            )
              report.finalReceipts[actor.name] = { text: receipt.text, revision: receipt.revision };
          }
        } catch {
          /* GET/download and non-JSON responses have no answer receipt. */
        }
      })().finally(() => receiptTasks.delete(task));
      receiptTasks.add(task);
    });
  }
  host.page.setDefaultTimeout(15000);
  host.page.setDefaultNavigationTimeout(30000);
  observe(host);
  async function api(actor, path, method = 'GET', body) {
    return actor.page.evaluate(
      async ({ path, method, body, controller }) => {
        let token;
        for (const key of Object.keys(localStorage)) {
          if (!/^sb-.*-auth-token$/.test(key)) continue;
          try {
            const session = JSON.parse(localStorage.getItem(key));
            if (session?.access_token) {
              token = session.access_token;
              break;
            }
          } catch {
            /* Ignore unrelated storage. */
          }
        }
        if (!token) throw new Error('No signed-in test identity in this browser profile.');
        const response = await fetch(`/api/${path}`, {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(controller ? { 'x-controller': controller } : {}),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store',
          signal: AbortSignal.timeout(25000),
        });
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            `${method} ${path.split('/')[0]} returned ${response.status}: ${data.error ?? 'Request rejected'}`,
          );
        return data;
      },
      { path, method, body, controller: actor.controller },
    );
  }
  const view = (actor = host) => api(actor, `sessions/${sessionId}`);
  const phase = (actor, name, timeout = 30000) =>
    expect(actor.page.locator(`[data-game-phase="${name}"]`)).toBeVisible({ timeout });
  const click = (actor, name) =>
    actor.page.getByRole('button', { name, exact: typeof name === 'string' }).click();
  async function checkpoint(name) {
    const s = await view();
    assert(!s.paused, `Unexpected pause during ${name}`);
    report.checks.push(name);
    onStep(name);
    return s;
  }
  async function assertRealtime(list) {
    if (allowPolling) return;
    await Promise.all(
      list.map((actor) =>
        expect(actor.page.locator('[data-session-transport="realtime"]')).toBeVisible({
          timeout: 30000,
        }),
      ),
    );
  }
  async function race(list = actors) {
    await Promise.all(list.map((actor) => expect(actor.page.locator('.buzzer')).toBeEnabled()));
    const windowId = (await view()).windowId;
    const target = Date.now() + 1000;
    await Promise.all(
      list.map((actor) =>
        actor.page.evaluate(
          (at) =>
            new Promise((resolve) =>
              setTimeout(
                () => {
                  document.querySelector('.buzzer')?.click();
                  resolve();
                },
                Math.max(0, at - Date.now()),
              ),
            ),
          target,
        ),
      ),
    );
    await expect.poll(async () => (await view()).respondent, { timeout: 25000 }).toBeTruthy();
    await expect
      .poll(
        () =>
          list.filter((actor) => actor.buzzes?.some((buzz) => buzz.windowId === windowId)).length,
        { timeout: 25000 },
      )
      .toBe(list.length);
    const responses = list.flatMap((actor) =>
      actor.buzzes.filter((buzz) => buzz.windowId === windowId),
    );
    assert.equal(
      responses.filter((buzz) => buzz.status === 200).length,
      1,
      'Exactly one concurrent buzz must be accepted.',
    );
    assert(
      responses.every((buzz) => buzz.status === 200 || buzz.status === 409),
      'Losing buzzes should be rejected, not fail with a server error.',
    );
    const s = await view();
    assert(
      list.some((actor) => actor.id === s.respondent),
      'Winner must be one of the eligible buzzing players.',
    );
    return s.respondent;
  }
  async function waitJudgment(actor, correct = true, daily = false) {
    await actor.page.locator('.buzzer').click();
    await phase(host, 'answering');
    await click(host, correct ? 'Correct' : 'Incorrect');
    await phase(host, correct ? 'reveal' : 'question');
  }
  async function assertPlayerScores(s) {
    const expected = JSON.stringify(s.players.map((p) => [p.id, p.score]));
    const views = await Promise.all(actors.map((actor) => view(actor)));
    assert(
      views.every(
        (v) => !v.paused && JSON.stringify(v.players.map((p) => [p.id, p.score])) === expected,
      ),
      'All player snapshots must agree on scores.',
    );
  }
  try {
    const board = makeTestBoard(`AUTOMATED TEST ${new Date().toISOString()}`);
    ({ id: boardId } = await api(host, 'games', 'POST', { board, pin }));
    report.boardId = boardId;
    host.controller = randomUUID();
    sessionId = randomUUID();
    await api(host, `games/${boardId}/start`, 'POST', {
      pin,
      controller: host.controller,
      requestId: sessionId,
      separate: false,
    });
    await host.page.evaluate(
      ({ id, controller }) => sessionStorage.setItem(`jeopardy:launch:${id}`, controller),
      { id: sessionId, controller: host.controller },
    );
    await host.page.goto(`${url}/host/session/${sessionId}`);
    await phase(host, 'lobby');
    joinCode = (await view()).joinCode;
    report.sessionId = sessionId;
    for (let i = 0; i < players; i++) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      });
      contexts.push(context);
      await configureContext?.(context, { role: 'player', index: i });
      const actor = {
        name: `Browser Test ${String(i + 1).padStart(2, '0')}`,
        context,
        page: await context.newPage(),
      };
      actor.page.setDefaultTimeout(15000);
      actor.page.setDefaultNavigationTimeout(30000);
      observe(actor);
      actors.push(actor);
    }
    await Promise.all(
      actors.map(async (actor) => {
        await actor.page.goto(`${url}/join`);
        await actor.page.getByLabel('GAME CODE', { exact: true }).fill(joinCode);
        await actor.page.getByLabel('Your name', { exact: true }).fill(actor.name);
        await click(actor, 'Join the game');
        await phase(actor, 'lobby', 45000);
      }),
    );
    const joined = await checkpoint(
      `${players} isolated browser profiles joined through the real Join UI`,
    );
    assert.equal(joined.players.length, players);
    for (const actor of actors) actor.id = joined.players.find((p) => p.name === actor.name)?.id;
    const audience = {
      name: 'Audience',
      context: host.context,
      page: await host.context.newPage(),
    };
    observe(audience);
    await audience.page.goto(`${url}/display/${sessionId}`);
    await phase(audience, 'lobby');
    await assertRealtime([host, audience, ...actors]);
    await checkpoint(
      allowPolling
        ? 'Connection modes recorded; fallback polling permitted'
        : 'Host, audience and every player subscribed to private Realtime',
    );
    report.transports = await Promise.all(
      [host, audience, ...actors].map(async (actor) => ({
        actor: actor.name,
        transport: await actor.page
          .locator('[data-session-transport]')
          .getAttribute('data-session-transport'),
      })),
    );
    await click(host, 'Start practice round');
    await phase(host, 'practiceOpen');
    const practiceWinner = await race();
    await phase(host, 'practiceAnswer');
    const practiceName = actors.find((actor) => actor.id === practiceWinner).name;
    await Promise.all(
      actors.map((actor) =>
        expect(
          actor.page.getByText(`${practiceName} buzzed first!`, { exact: true }),
        ).toBeVisible(),
      ),
    );
    assert((await view()).players.every((p) => p.score === 0));
    await click(host, 'Finish practice');
    await click(host, 'Start Jeopardy');
    await phase(host, 'board');
    await checkpoint('Simultaneous practice buzz: one shared winner and unchanged scores');
    let regular = 0;
    for (const question of board.questions) {
      await host.page.locator(`[data-clue-id="${question.id}"]`).click();
      if (question.dailyDouble) {
        await phase(host, 'dailyWager');
        const s = await view();
        const assigned = actors.find((actor) => actor.id === s.daily.playerId);
        assert(assigned);
        assert.equal(s.daily.playerId, s.nextSelectorId);
        await assigned.page.getByLabel(/Your wager/).fill('0');
        await click(assigned, 'Save wager');
        await expect(audience.page.getByText('Saved wager: $0', { exact: true })).toBeVisible();
        await click(host, 'Lock wager & reveal clue');
        await phase(host, 'dailyAnswer');
        await click(host, 'Correct');
        await phase(host, 'reveal');
      } else {
        await phase(host, 'question');
        const actor = actors[regular % actors.length];
        if (regular === 0) {
          await waitJudgment(actors[0], false);
          await waitJudgment(actors[1], false);
          await click(host, /Undo last judgment/);
          await phase(host, 'answering');
          await click(host, /Undo last judgment/);
          await phase(host, 'answering');
          await click(host, 'Correct');
          await phase(host, 'reveal');
        } else await waitJudgment(actor);
        regular++;
      }
      if (regular === 1 && !question.dailyDouble) {
        const before = await view();
        await host.page.close();
        host.page = await host.context.newPage();
        host.page.setDefaultTimeout(15000);
        host.page.setDefaultNavigationTimeout(30000);
        observe(host);
        await host.page.goto(`${url}/host/session/${sessionId}`);
        await host.page.getByLabel('Host PIN', { exact: true }).fill(pin);
        await click(host, 'Resume / take control');
        await host.page
          .locator('.pause-banner')
          .getByRole('button', { name: 'Continue game', exact: true })
          .click();
        await phase(host, 'reveal');
        assert.equal((await view()).joinCode, joinCode);
        await assertPlayerScores(before);
        await assertRealtime([host]);
      }
      await phase(audience, 'reveal');
      await click(
        host,
        question === board.questions.at(-1) ? 'On to Final Jeopardy' : 'Back to the board',
      );
      await phase(host, question === board.questions.at(-1) ? 'finalWager' : 'board');
      if ((question.row * 6 + question.category + 1) % 5 === 0)
        onStep(`${question.row * 6 + question.category + 1}/30 clues completed`);
    }
    const final = await checkpoint(
      'All 30 clues, multiple undos, Daily Double, audience updates and host close/reopen completed',
    );
    assert(final.players.every((p) => p.score > 0));
    await assertRealtime([host, audience, ...actors]);
    await Promise.all(
      actors.map(async (actor) => {
        const score = final.players.find((p) => p.id === actor.id).score;
        await phase(actor, 'finalWager');
        await actor.page.getByLabel(/Your wager/).fill(String(Math.abs(score)));
        await click(actor, 'Save wager');
        await expect(
          actor.page.getByText(
            `Your wager: $${Math.abs(score).toLocaleString('en-US')}. You can change it until the host reveals the clue.`,
            { exact: true },
          ),
        ).toBeVisible();
      }),
    );
    await expect(
      host.page.locator('.submission-list').getByText('✓ Wager saved', { exact: true }),
    ).toHaveCount(players);
    onStep('All Final wagers saved');
    await click(host, 'Lock wagers & reveal clue');
    await phase(host, 'finalAnswer');
    onStep('Final response window opened');
    await Promise.all(
      actors.map(async (actor, index) => {
        await phase(actor, 'finalAnswer');
        const textbox = actor.page.getByRole('textbox', { name: 'Your response', exact: true });
        let edit = 0;
        const editable = () =>
          actor.page
            .locator('[data-game-phase="finalAnswer"] textarea')
            .evaluateAll((nodes) => nodes.some((node) => !node.disabled));
        while (await editable()) {
          const text =
            ending === 'normal' && index === 0
              ? board.final.answer
              : `${actor.name} synthetic Final edit ${++edit}`;
          try {
            await textbox.fill(text, { timeout: 5000 });
          } catch (error) {
            if (!(await editable())) break;
            throw error;
          }
          await actor.page.waitForTimeout(800);
        }
      }),
    );
    await phase(host, 'finalReveal', 45000);
    await Promise.all([...receiptTasks]);
    assert.equal(
      Object.keys(report.finalReceipts).length,
      players,
      'Every player must have a successful save receipt.',
    );
    await Promise.all(
      actors.map(async (actor) => {
        const frozen = await view(actor);
        assert.deepEqual(
          {
            text: frozen.finalEntries[actor.id].text,
            revision: frozen.finalEntries[actor.id].revision,
          },
          report.finalReceipts[actor.name],
        );
      }),
    );
    await expect(
      host.page.getByRole('heading', {
        name: `${players} of ${players} responses saved`,
        exact: true,
      }),
    ).toBeVisible();
    await expect(audience.page.locator('.final-submissions')).toHaveCount(0);
    await checkpoint(
      'Full Final autosave window: every latest acknowledged response retained and audience submission details private',
    );
    await assertRealtime([host, audience, ...actors]);
    await click(host, 'Reveal player responses');
    for (let i = 0; i < players; i++) {
      const s = await view();
      const correct = ending === 'normal' && s.finalReviewPlayer === actors[0].id;
      await click(host, correct ? 'Correct' : 'Incorrect');
      await expect
        .poll(
          async () =>
            Object.values((await view()).finalEntries).filter((entry) => entry.judged).length,
        )
        .toBe(i + 1);
    }
    await click(host, ending === 'tie' ? /Start sudden-death tiebreaker/ : /Announce the winner/);
    let winnerId;
    if (ending === 'tie') {
      await phase(host, 'tieSetup');
      const tied = await view();
      assert.equal(tied.tiebreaker.playerIds.length, players);
      await click(host, 'Present next saved clue');
      await phase(host, 'tieQuestion');
      let s = await view();
      while (s.phase === 'tieQuestion') {
        const actor = actors.find((a) => !s.attempted.includes(a.id));
        await phase(actor, 'tieQuestion');
        await actor.page.locator('.buzzer').click();
        await phase(host, 'tieAnswer');
        await click(host, 'Incorrect');
        s = await view();
        assert(!s.tiebreaker.winnerId, 'A miss must never award a default win.');
      }
      assert.equal(s.phase, 'tieReveal');
      await click(host, 'Prepare another clue');
      await click(host, 'Present next saved clue');
      await phase(host, 'tieQuestion');
      winnerId = await race();
      await phase(host, 'tieAnswer');
      await click(host, 'Correct · wins game');
    } else winnerId = actors[0].id;
    const winnerName = actors.find((actor) => actor.id === winnerId).name;
    await Promise.all(
      [host, audience, ...actors].map((actor) =>
        expect(
          actor.page.getByRole('heading', { name: `${winnerName} wins!`, exact: true }),
        ).toBeVisible({ timeout: 30000 }),
      ),
    );
    const result = await view();
    assert.equal(result.phase, 'finished');
    await assertPlayerScores(result);
    if (ending === 'tie') {
      assert.equal(result.tiebreaker.winnerId, winnerId);
      assert(result.players.every((p) => p.score === 0));
    }
    const downloadEvent = host.page.waitForEvent('download');
    await click(host, 'Download results (CSV)');
    const download = await downloadEvent;
    assert.equal(await download.failure(), null);
    const stream = await download.createReadStream();
    let csv = '';
    for await (const chunk of stream) csv += chunk.toString();
    assert(csv.includes(ending === 'tie' ? 'Won sudden-death tiebreaker' : 'Completed'));
    await checkpoint(
      ending === 'tie'
        ? 'All tied players missed without a default win, second clue resolved tie, common winner and CSV verified'
        : 'Normal winner and CSV verified',
    );
    report.outcome = 'passed';
  } catch (error) {
    report.outcome = 'failed';
    report.error =
      error instanceof Error ? error.message.replaceAll(pin, '[test PIN]') : 'Test failed';
  } finally {
    if (sessionId && boardId) {
      try {
        const s = await view();
        if (!['finished', 'ended'].includes(s.phase)) {
          await api(host, `sessions/${sessionId}/end`, 'POST', {
            confirmed: true,
            actionId: randomUUID(),
          });
          report.cleanup.sessionEnded = true;
        }
      } catch {
        report.cleanup.error =
          'Could not confirm/end the isolated test session. Use the host dashboard.';
      }
    }
    if (boardId) {
      try {
        await api(host, `games/${boardId}/archive`, 'POST', { archived: true });
        report.cleanup.boardArchived = true;
      } catch {
        report.cleanup.error = 'Could not archive the isolated test board. Use the host dashboard.';
      }
    }
    await Promise.all([...receiptTasks]);
    report.finishedAt = new Date().toISOString();
    report.durationSeconds = Math.round(
      (Date.parse(report.finishedAt) - Date.parse(report.startedAt)) / 1000,
    );
    const latencies = report.requests.map((request) => request.ms).sort((a, b) => a - b);
    if (latencies.length)
      report.requestLatencyMs = {
        p50: latencies[Math.floor(latencies.length * 0.5)],
        p95: latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)],
        max: latencies.at(-1),
      };
    report.unexpectedServerErrors = report.requests.filter(
      (r) => r.status >= 500 || r.status === 429,
    ).length;
    if (report.unexpectedServerErrors) {
      report.outcome = 'failed';
      report.error ??= 'Server errors or throttling were recorded.';
    }
    await Promise.all(contexts.map((context) => context.close()));
    return report;
  }
}
