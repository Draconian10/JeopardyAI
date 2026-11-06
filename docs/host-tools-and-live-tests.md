# Host diagnostics, draft recovery and live-browser validation

## Connection health

Open **Connection health** in the host console. It distinguishes a subscribed Realtime channel from fallback polling and shows the last acknowledged request, last accepted game snapshot, recent request round trip, recent p95 round trip and failed synchronization requests. Timing samples are bounded to the latest twenty requests and include this console's authentication/network wait. All readings reuse existing requests; opening the panel creates no background traffic. Refresh uses the existing coalesced snapshot request.

Each player row shows their persisted last-contact time from the most recent authorized snapshot. “Seen recently,” “Contact delayed” and “No recent contact” are observations, not proof that a phone is awake or offline. The panel does not measure other devices' individual network latency, and a subscribed channel alone does not prove prompt message delivery. Diagnostics never renew leases, alter scores or bypass a pause. The panel is absent from player and audience views. No database migration is required.

## Recover board edits

Board edits and unapplied JSON are backed up on this browser, scoped to the signed-in host and board. A different signed-in host does not see those recovery copies. The Host PIN field, auth credentials and session controller are excluded. Copies contain the board's clues/correct responses and should be treated as private on a shared computer. They do not move between devices and may disappear if site storage is cleared. Copies remain on this browser after sign-out until saved, discarded, expired or cleared; discard them or clear site data before sharing a browser with someone who should not have the board content.

After a reload/crash, choose **Restore draft** or **Discard recovery copy**. When several editor copies exist, select the desired timestamp. Restoring only changes the editor; an existing board does not autosave the restored copy until you explicitly select **Save board**. A changed server version produces a warning, and normal optimistic concurrency still rejects a stale server save. Saving removes only the acknowledged local copy and the unchanged recovery source; copies updated by another tab are not removed. Unapplied JSON remains recoverable until applied. Up to five recent copies are retained per host/board, expiring after seven days. Blocked/full browser storage displays a recovery-unavailable message while normal server saving remains available.

## Run a real fifteen-browser game from one computer

This opt-in test targets the URL you supply. It does not run as part of normal unit tests and needs no service-role key. Use a separate staging deployment/Supabase project and a dedicated, confirmed host account. It creates a test board/session, fifteen anonymous Auth users and retained historical test results. It only ends/archives the board/session it creates; it never selects or edits your existing games. Anonymous users are not automatically deleted. Verify your staging Auth signup quotas/CAPTCHA configuration before repeated runs. Quota failures are reported, not bypassed.

Install Node.js 22+, then in the repository:

```bash
npm ci
npx playwright install chromium
npm run test:live -- --url https://YOUR-STAGING-DEPLOYMENT.vercel.app
```

On Linux, the browser may also need `npx playwright install --with-deps chromium`.

Sign into the dedicated test host in the opened window. The runner transfers auth state in memory to a headless browser, closes the login window and starts automatically. Passwords, access tokens and browser storage state are not saved to disk. You do not need fifteen phones, fifteen manual logins or a manually prepared board.

The test uses isolated mobile-sized browser contexts for players plus a host and audience. Setup and readback use authenticated APIs; gameplay uses the actual UI, actual Auth, actual database persistence and actual Realtime connections of the supplied deployment. It covers:

- Fifteen joins, private Realtime subscription checks and simultaneous practice buzzing with one accepted winner.
- All thirty clues, wrong responses and multiple undos, player-owned Daily Double wagers, audience updates, host close/reopen and PIN/Continue.
- All Final wagers and the full thirty-second autosave window. Every latest acknowledged response is compared with its frozen server entry.
- Host judging, a fifteen-way tie, a clue where everyone misses without a default winner, a second clue with simultaneous buzzing, common winner screens and CSV download.

The default ending is sudden death. Use `--ending normal` for a normal win. Use `--players 3` for a smaller diagnostic run. Private Realtime subscription is required by default; `--allow-polling` explicitly permits fallback when diagnosing connectivity, and the report records that weaker requirement.

The report is written to `test-results/live-browser/report.json` (git-ignored, private file permissions where supported). It records test stages, request statuses/timings, connection modes, synthetic response acknowledgements and cleanup. It contains no credentials or PIN. Failures return a nonzero exit code. If cleanup fails, the report identifies the test session so the host can end it from the dashboard.

For unattended execution, set `LIVE_HOST_EMAIL` and `LIVE_HOST_PASSWORD` in your own process environment, then add `--headless`. Do not put credentials in command-line arguments, source code, reports or committed files. The two public Supabase settings are read by the deployed app as usual; the runner does not need them separately.

A single-computer run validates application behavior and the supplied cloud services. It does not reproduce fifteen physical radio connections, OS screen locking or the venue Wi-Fi. Browser background timer throttling is disabled deliberately so this test measures application/service behavior. Use the host health panel to compare real venue behavior later. A passing short test is not a guarantee of uninterrupted connectivity.

## What can run without cloud access

The runner itself has an offline browser regression fixture, separate from the real deployment command:

```bash
npm run test:live:fixture
```

It defaults to three isolated browser profiles and uses the real UI/game engine with emulated Auth/API/Realtime transport and accelerated fallback polling. It does **not** call Supabase or Vercel and does **not** verify cloud Realtime. To exercise fifteen profiles in that fixture on macOS/Linux:

```bash
LIVE_FIXTURE_PLAYERS=15 npm run test:live:fixture
```

The existing `test:stress` full-game scenario separately checks actual API handlers and all SQL migrations with local PGlite. These local tests complement each other; neither is described as a successful live deployment test. Network policy currently prevents executing the real deployment run from the assistant environment. The live runner is provided so it can run from a computer with access to the target.
