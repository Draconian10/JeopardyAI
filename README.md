# Jeopardy Live

A responsive, self-hostable Jeopardy game for **Next.js + Vercel + Supabase**. The host runs the board from a laptop; players join from their phones with a six-digit code. This is an independent trivia app, not affiliated with Jeopardy!.

## What is implemented

- Host email/password accounts and guest player identities.
- Saved boards, editable categories and values, 1–8 columns and rows, duplicate/archive actions, and a complete 30-question starter board.
- Paste category-based JSON to create a complete board, with validation, an editable example, and database-stored JSON for saved games and hosted sessions.
- Server autosave for existing boards; explicit initial Save with a six-digit host PIN. Incomplete drafts can be saved, but cannot be started.
- Lobby with a separate six-digit join code, QR code, player list, connection status, lobby lock, and removal.
- Server-authoritative, atomic first-buzz arbitration and 30-second windows.
- Correct/incorrect scoring, remaining-time resumption after a miss, one attempt per player per question, and answer reveal.
- Hidden Daily Double, host-selected participant, and wagers capped at the absolute score.
- Final Jeopardy category → private wagers → 30-second written answers → individual judging → joint winners if tied.
- Standings after every question with score changes and rank movement.
- Persistent sessions, automatic host-disconnect pause, PIN-protected Resume, explicit Continue, and one controlling host tab.
- Private audience display, keyboard buzzer, optional sound/vibration, responsive layouts, reduced-motion support.

## Prerequisites

- Node.js **22 or newer** (use Node 22 in Vercel).
- A Supabase project and a Vercel account.
- This GitHub repository connected to Vercel.

## 1. Configure Supabase

1. Create a Supabase project. Choose a region near the players; use the closest Vercel function region as well.
2. Open **SQL Editor**, paste the contents of [`supabase/migrations/001_initial.sql`](supabase/migrations/001_initial.sql), and run it **once**, then apply [`002_question_json.sql`](supabase/migrations/002_question_json.sql). For an existing installation, run only unapplied migrations in order. Alternatively, use the Supabase CLI migration workflow.
3. Under **Authentication → Providers**, enable **Email** and **Anonymous Sign-Ins**. Anonymous users are players; hosts use email/password accounts.
4. Under **Authentication → URL Configuration**, set the Site URL to your Vercel production URL. Add your local URL (`http://localhost:3000`) and any preview URLs you intentionally use to the redirect allowlist.
5. Under **Realtime Settings**, disable **Allow public access**, so channels must be private. The migration installs the channel authorization policy. No Postgres Changes publication is required.
6. Keep email confirmation enabled for deployed host accounts. Configure email delivery as needed. The app tells new hosts to confirm their email before signing in. For local development only, you can disable confirmation in your separate development project.
7. Copy your **Project URL**, **anon public key**, and **service_role key**. Never place the service-role key in a `NEXT_PUBLIC_` variable.

The application uses these tables: `games`, `sessions`, `session_members`, and `rate_limits`. Browsers cannot directly read private board/session JSON or execute privileged mutation functions.

## 2. Run locally

```bash
npm ci
cp .env.example .env.local
```

Fill `.env.local`:

| Variable                        | Value                                 | Visibility  |
| ------------------------------- | ------------------------------------- | ----------- |
| `NEXT_PUBLIC_SUPABASE_URL`      | Supabase Project URL                  | Public      |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon public key              | Public      |
| `SUPABASE_SERVICE_ROLE_KEY`     | Supabase service-role key             | Server only |
| `RATE_LIMIT_SECRET`             | Random secret, at least 32 characters | Server only |

Generate a rate-limit secret with `openssl rand -hex 32`, then run:

```bash
npm run dev
```

Open `http://localhost:3000`. Create a host account, confirm your email, then select **Create new game**. For a quick start, select **Load starter board**, set a six-digit host PIN, and save. Return to **Your boards** to start a session.

Use a separate browser profile/private window or a phone for each player. A host account cannot join its own session as a player. Keep the guest browser's site data to preserve that player's identity and reconnection ability.

## 3. Deploy on Vercel

1. Import this repository into Vercel. Framework preset: **Next.js**. Repository root is the project root; no custom output directory or build command is needed.
2. Choose Node.js 22 and configure the four variables above for Production. Public variables must be present **at build time**.
3. Deploy, then set the Supabase Site URL/redirect allowlist to your actual deployment URL.
4. Use a **separate Supabase project for previews/development**. A preview using production credentials can modify production games.
5. Sign in, start a session, and join from a second device. Verify buzz arbitration and close/reopen the host tab before your first real game night.

No long-running WebSocket server is deployed inside the app. Vercel handles short authenticated HTTP commands; Supabase provides persistent state and private Realtime notifications. No cron job is required to keep sessions alive.

## Import questions from JSON

In **Create new game** (or an existing board editor), select **Import JSON**. Paste your JSON or choose **Load JSON example**, then select **Validate & apply JSON**. A valid import replaces the board only after confirmation. Enter the host PIN separately and save the new game; existing games also autosave after import.

Use the complete [example](examples/question-import.json) and [format guide](docs/question-json.md). Imports require 1–8 unique categories, 1–8 questions per category with the same count in every category, valid point values, exactly one Daily Double, and a complete Final Jeopardy question. Errors do not replace your current board.

Apply `supabase/migrations/002_question_json.sql` to an existing database before using this feature. PostgreSQL stores canonical category-based JSON in **`games.question_json`** and **`sessions.question_json`**. Stored generated columns automatically backfill old records and stay synchronized with manual edits, duplication, and autosave. The session copy remains based on its frozen board, so editing a saved game cannot change an ongoing match. Whitespace and omitted optional fields are normalized; the original pasted formatting is not stored. These columns contain answers and retain the existing private access rules.

## Resume behavior

Closing the host window never ends a session. Every accepted action is persisted to PostgreSQL before success is reported. The host controller heartbeats every five seconds. After **15 seconds without a heartbeat**, the session is considered disconnected and paused at that boundary.

When the host returns, choose **Host Game → the board's In Progress session → Resume**, enter the session's host PIN, and select **Continue game**. The same session ID, join code, players, scores, current question, pending respondent, wagers, answers, and remaining time are restored. The session PIN is a snapshot of the PIN at launch; changing the saved board's PIN does not change an existing session's PIN.

If all browsers are closed, the database is reconciled on the next read: the effective pause instant is still the last host heartbeat plus 15 seconds. A timer expiring before that instant resolves normally. Time is not retroactively restored. Final answer drafts already received remain saved; no new answers are accepted while paused.

Taking control in another tab pauses the game and invalidates the previous controller's commands. A finished or explicitly ended session remains viewable in history but cannot resume. In-progress sessions have no automatic deletion or gameplay expiry.

## Game rules

- Selecting a regular tile immediately displays the question and opens a 30-second buzzer window.
- First valid server-accepted buzz wins. The timer pauses during the spoken answer and host judgment; spoken answers have no automatic deadline.
- Correct: award the tile value and reveal the answer. Incorrect: deduct the tile value, exclude that player for this question, and resume the **remaining** time with a fresh buzzer-window ID.
- When time expires or everyone has missed, reveal the answer. Host chooses when to return to the board.
- Daily Double: no buzzer; host chooses the player, locks the wager, reveals the question, and judges the spoken answer.
- Daily Double and Final wager range: **0 through absolute current/pre-Final score**, whole dollars. A score of zero permits only a zero wager. Negative-score players are eligible.
- Final: host reveals the category; players save/change private wagers until the host opens the question. Missing wagers default to zero after host confirmation.
- Final answers autosave at most twice a second, one request at a time. Players may also explicitly Save. **Only text successfully received before the server deadline counts**; unsent keystrokes are not guaranteed. Latest received text locks at expiry; blank answers are incorrect.
- Final review proceeds from lowest to highest pre-Final score. Answers/wagers become public after each judgment. Highest final score wins; ties produce joint winners.
- The host can correct the last regular/Daily Double judgment before another accepted buzz or the next question. The audit history retains the correction action. Final judgments are locked after approval/rejection.
- Up to 50 player seats per session; intended for casual game nights. See architecture notes before increasing this limit or operating many concurrent rooms.

## Structure

```text
app/
  api/[...path]/route.ts       Authenticated API and input validation
  host/                       Dashboard, editor, and live host routes
  join/                       Code/name entry
  play/[id]/                  Mobile player route
  display/[id]/               Audience-only projection (same signed-in browser)
  globals.css                 Responsive theme and game states
components/
  auth.tsx                    Host authentication and setup notice
  dashboard.tsx               Saved boards, launch/resume, history
  editor.tsx                  Board editor and autosave
  join.tsx                    Guest join flow
  session.tsx                 Host/player/audience gameplay UI
  use-session.ts              Realtime, polling, heartbeats, clock synchronization
lib/
  client.ts                   Browser auth/API client
  game/                       Pure engine, schemas, types, starter content
  server/                     Server-only database, PIN, rate-limit, CAS helpers
supabase/migrations/           Database schema, grants, RLS, privileged functions
tests/                        Engine and real PostgreSQL (PGlite) tests
  e2e/                        Desktop/mobile browser flows with mocked transport
docs/                         Architecture and validation reference
.github/workflows/ci.yml       Type check, tests, build, browser checks
```

## Verification

```bash
npm run typecheck
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

Engine tests use deterministic clocks. Database tests execute the actual migration in PGlite (PostgreSQL compiled to WASM), with minimal stubs for Supabase's `auth` and `realtime` schemas. They verify CAS, constraints, function grants, RLS, rate limits, and persistence. Browser tests mock authentication/API transport and exercise the real UI and engine on desktop/mobile; they do **not** establish a live Supabase/Vercel deployment or measure real network fairness. Perform the two-device deployment check above with your configured project.

`npm run format:check` verifies formatting; `npm run format` applies it.

## Operational notes

- Internet latency affects buzzer order. The app orders by authoritative server acceptance, not untrusted client timestamps.
- Do not share the host console on a projector: use **Audience display**. It has no unrevealed answer payloads and does not heartbeat as the host.
- Enable Supabase backups appropriate to your needs. Guest identity recovery depends on retaining that browser's auth storage; lost guest site data cannot automatically reclaim a name.
- Heartbeat throttling when a host browser is suspended can pause the game. Returning and continuing is safe.
- Monitor Supabase database/Realtime and Vercel usage. Full session state is read for authorized snapshots; the notification channel carries version numbers only. This intentionally prioritizes durable correctness and straightforward deployment over high-scale esports performance.
- Rate-limit rows contain HMAC-hashed identifiers. You may periodically delete `rate_limits` rows whose `window_start` is older than one day. Never delete unfinished sessions as part of that maintenance.

## Returning as a player

Going Home does not remove a player from their session. Home and Join Game show **Return to game** for unfinished sessions belonging to the currently signed-in player. This survives page refreshes and restores the existing player seat and score without entering the code/name again. Finished/ended sessions and removed players are excluded. The lookup uses authenticated server-side membership checks and returns only safe session summaries. Guest recovery requires the same browser profile's retained authentication storage; no additional database migration is needed.
