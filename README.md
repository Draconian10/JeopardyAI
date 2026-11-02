# Jeopardy Live

A responsive, self-hostable Jeopardy game for **Next.js + Vercel + Supabase**. The host runs the board from a laptop; players join from their phones with a six-digit code. This is an independent trivia app, not affiliated with Jeopardy!.

## What is implemented

- Host email/password accounts and guest player identities.
- Saved boards, editable categories and values, 1–8 columns and rows, duplicate/archive actions, and a complete 30-clue starter board.
- Paste category-based JSON to create a complete board, with validation, an editable example, and database-stored JSON for saved games and hosted sessions.
- Server autosave for existing boards; explicit initial Save with a six-digit host PIN. Incomplete drafts can be saved, but cannot be started.
- Lobby with a separate six-digit join code, QR code, player list, connection status, lobby lock, and removal.
- Server-authoritative, atomic first-buzz arbitration and 30-second windows.
- Correct/incorrect scoring, remaining-time resumption after a miss, one attempt per player per clue, and correct-response reveal.
- Hidden Daily Double, automatically assigned selecting player, and wagers capped at the absolute score.
- Final Jeopardy category → private wagers → 30-second written answers → individual judging → sudden-death buzzer clues for tied leaders.
- Animated standings after every clue with score changes, moving player rows, and rank movement; reduced-motion preferences are respected.
- End sessions directly from the host dashboard, unscored practice buzzers, and an optional per-session response deadline.
- Persistent sessions, automatic host-disconnect pause, PIN-protected Resume, explicit Continue, and one controlling host tab.
- Private audience display, keyboard buzzer, optional sound/vibration, responsive layouts, reduced-motion support.

## Prerequisites

- Node.js **22 or newer** (use Node 22 in Vercel).
- A Supabase project and a Vercel account.
- This GitHub repository connected to Vercel.

## 1. Configure Supabase

1. Create a Supabase project. Choose a region near the players; use the closest Vercel function region as well.
2. Open **SQL Editor**, paste the contents of [`supabase/migrations/001_initial.sql`](supabase/migrations/001_initial.sql), and run it **once**, then apply [`002_question_json.sql`](supabase/migrations/002_question_json.sql) and [`003_saved_tiebreakers.sql`](supabase/migrations/003_saved_tiebreakers.sql). For an existing installation, run only unapplied migrations in order. Alternatively, use the Supabase CLI migration workflow.
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

Open `http://localhost:3000`. Create a host account, confirm your email, then select **Create new board**. For a quick start, select **Load starter board**, set a six-digit host PIN, and save. Return to **Your boards** to start a session.

Use a separate browser profile/private window or a phone for each player. A host account cannot join its own session as a player. Keep the guest browser's site data to preserve that player's identity and reconnection ability.

## 3. Deploy on Vercel

1. Import this repository into Vercel. Framework preset: **Next.js**. Repository root is the project root; no custom output directory or build command is needed.
2. Choose Node.js 22 and configure the four variables above for Production. Public variables must be present **at build time**.
3. Deploy, then set the Supabase Site URL/redirect allowlist to your actual deployment URL.
4. Use a **separate Supabase project for previews/development**. A preview using production credentials can modify production games.
5. Sign in, start a session, and join from a second device. Verify buzz arbitration and close/reopen the host tab before your first real game night.

No long-running WebSocket server is deployed inside the app. Vercel handles short authenticated HTTP commands; Supabase provides persistent state and private Realtime notifications. No cron job is required to keep sessions alive.

## Import questions from JSON

In **Create new board** (or an existing board editor), select **Import JSON**. Paste your JSON or choose **Load JSON example**, then select **Validate & apply JSON**. A valid import replaces the board only after confirmation. Enter the host PIN separately and save the new game; existing games also autosave after import.

Use the complete [example](examples/question-import.json) and [format guide](docs/question-json.md). Imports require 1–8 unique categories, 1–8 questions per category with the same count in every category, valid clue values, exactly one Daily Double, and a complete Final Jeopardy clue. Errors do not replace your current board.

Apply `supabase/migrations/002_question_json.sql` to an existing database before using this feature. PostgreSQL stores canonical category-based JSON in **`games.question_json`** and **`sessions.question_json`**. Stored generated columns automatically backfill old records and stay synchronized with manual edits, duplication, and autosave. The session copy remains based on its frozen board, so editing a saved game cannot change an ongoing match. Whitespace and omitted optional fields are normalized; the original pasted formatting is not stored. These columns contain answers and retain the existing private access rules.

## Resume behavior

Closing the host window never ends a session. Every accepted action is persisted to PostgreSQL before success is reported. The host controller heartbeats every five seconds. After **15 seconds without a heartbeat**, the session is considered disconnected and paused at that boundary.

When the host returns, choose **Host Game → the board's In Progress session → Resume**, enter the session's host PIN, and select **Continue game**. The same session ID, join code, players, scores, current clue, pending respondent, wagers, answers, and remaining time are restored. The session PIN is a snapshot of the PIN at launch; changing the saved board's PIN does not change an existing session's PIN.

If all browsers are closed, the database is reconciled on the next read: the effective pause instant is still the last host heartbeat plus 15 seconds. A timer expiring before that instant resolves normally. Time is not retroactively restored. Final response drafts already received remain saved; no new answers are accepted while paused.

Taking control in another tab pauses the game and invalidates the previous controller's commands. A finished or explicitly ended session remains viewable in history but cannot resume. In-progress sessions have no automatic deletion or gameplay expiry.

## Game rules

- Selecting a regular tile immediately displays the clue and opens a 30-second buzzer window.
- First valid server-accepted buzz wins. The 30-second buzzer timer pauses during the spoken answer. By default spoken answers have no deadline; the host can enable a separate 5–60 second response deadline in the lobby.
- Correct: award the clue value and reveal the correct response. Incorrect: deduct the clue value, exclude that player for this question, and resume the **remaining** time with a fresh buzzer-window ID.
- When time expires or everyone has missed, reveal the correct response. Host chooses when to return to the board.
- Daily Double: no buzzer; the selecting player is assigned automatically and saves their wager on their own screen. The saved wager is displayed to everyone. The host locks it, reveals the clue, and judges the spoken response.
- Daily Double and Final wager range: **0 through absolute current/pre-Final score**, whole dollars. A score of zero permits only a zero wager. Negative-score players are eligible.
- Final: host reveals the category; players save/change private wagers until the host opens the clue. Missing wagers default to zero after host confirmation.
- Final responses autosave at most twice a second, one request at a time. Players may also explicitly Save. **Only text successfully received before the server deadline counts**; unsent keystrokes are not guaranteed. Latest received text locks at expiry; blank responses are incorrect.
- Final review proceeds from lowest to highest pre-Final score. Each answer/wager becomes public when that player is selected for Final review. A unique highest final score wins. A tie for first enters sudden death: the host supplies a category/clue/answer, only tied leaders buzz, and only a correct response wins. Misses do not change scores or award a default win. If everyone misses or the 30-second buzzer window expires, reveal the correct response and prepare another clue; all tied leaders are eligible again. The optional spoken-response deadline also applies without score deductions.
- The host can undo regular/Daily Double judgments in reverse order for the current clue, including after later players buzz. Each undo restores that player’s response for manual judging. Moving back to the board or on to Final Jeopardy clears the entire clue history. The audit history retains the correction action. Final judgments are locked after approval/rejection.
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

## Game-night controls

- **Dashboard End session:** End any unfinished session beside its Resume button after explicit confirmation. The signed-in owner is required, but no game PIN or controller claim is needed. Scores/history remain saved, the join code becomes inactive, and all connected views receive the update. Ending does not delete the board.
- **Practice:** In the host lobby, select Start practice round. Everyone gets a 30-second practice buzzer window. First accepted buzz wins the practice attempt; the host can reset it repeatedly or Finish practice to return to the lobby. No points, question consumption, Daily Double, or Final wagers are affected. Players may keep joining while practice is running if the lobby is unlocked.
- **Response deadline:** In the lobby choose Off (default), or 5, 10, 15, 20, 30, 45, or 60 seconds. It applies after a successful regular-clue or tiebreaker buzz. In a tiebreaker, expiry counts as a miss without score deductions. For regular clues, the server automatically marks an expired response incorrect, deducts the clue value once, excludes that respondent, and reopens the remaining buzzer time for others. When no eligible player remains, the answer is revealed. Daily Double and Final Jeopardy keep their existing rules. Settings persist with the session; existing sessions default to Off.
- **Pause/resume:** Both the response deadline and buzzer window pause during host pause/disconnection and restore remaining time on Continue. An expiry before host-loss detection resolves normally. Undo last judgment can reverse timeouts within the current clue; this hands the restored attempt back to the host for manual judgment, without restarting the deadline.
- **Standings:** Rows move to their new ranks as scores change, with highlighted score updates and question score deltas. The reveal screen animates from the pre-question order; the live sidebar animates from the last displayed positions. With reduced motion enabled, rankings update immediately.

These additions use existing session JSON and CAS persistence; **no new Supabase migration is required**.

## Connection recovery and final celebration

Temporary snapshot/network errors clear automatically after a successful game snapshot, including when returning to a tab. The last known score stays visible during reconnection. Request ordering prevents an older failed fetch from overwriting a newer successful connection. Gameplay validation errors remain visible until the next explicit action; background polling does not dismiss them.

Completed games show a brief, silent gold-and-purple confetti burst and a refined final-results panel. The overlay never intercepts controls, runs once per match per browser tab (tracked with session storage), and stops after roughly 3.4 seconds. Refreshing the same results does not replay it. Reduced-motion preferences disable confetti, and sessions ended early do not trigger a winner celebration. No new dependency or Supabase migration is required.

## Download results

On a completed or explicitly ended session, the signed-in host can select **Download results (CSV)** on the results screen. Past results remain available through **Host Game → session history**. The download contains one table with a `Record type` column: **Final standing**, **Clue summary** (one player per played question, including zero changes), and **Score event** (individual applied judgments/timeouts). Filter by record type before summing deltas; summaries and events describe the same scoring at different levels.

The file includes ranks (equal scores share a rank), player IDs/names, removal status, session ID/code, category, question text, tile value, numeric score changes, running scores and UTC event timestamps. Daily Double/Final wagers are reflected in the applied deltas. Removed players retain their history but receive no final rank. Ended sessions are marked **Ended early**; unplayed board questions and answer text are excluded. CSV quoting handles commas, quotes and multiline names; UTF-8 and formula-like text are handled for spreadsheet use. Players and other hosts cannot download another host's results. No database migration is needed.

Fresh sessions now open the lobby after a single PIN check. The launching tab receives control atomically at creation, using a one-use handoff with no stored PIN. Reloading/reopening the console still requires the existing PIN-protected Resume and explicit Continue flow.

## Sudden death and projector readability

After every Final response has been judged, a tie changes the host action to **Start sudden-death tiebreaker**. Save optional backup clues in **Create/Edit Game → Sudden-death tiebreakers**, or include them in the JSON `tiebreakers` array. During a tie, select **Present next saved clue**. The list is consumed in order and its position survives resume. The host can enter a custom clue if the list is empty or exhausted. There is no dollar value or wager; the first tied leader to buzz and answer correctly wins. Nonleaders watch. A miss excludes that player only for the current clue. If no one succeeds, select **Prepare another clue**; no player wins by default. Final standings, confetti and the results CSV identify the tiebreaker winner while keeping monetary scores unchanged. The CSV also includes tiebreaker responses and unresolved-round summaries, with zero score changes. All accepted tiebreaker state survives host disconnection and PIN-protected resume.

During a regular or tiebreaker buzzed response, the clue is removed from the host and audience payload/display until a miss reopens it or a reveal occurs. Private host answers remain available for judging. Stage-specific action errors clear as play moves to a new stage, question or buzzer window; polling the same stage does not dismiss an applicable validation error.

Use **Audience display** on the projector, rather than exposing private host controls. Larger responsive clue/category/timer/standing text, stronger contrast and wrapping improve distance readability while preserving mobile layouts and scrolling for long clues. Apply migration `003_saved_tiebreakers.sql` for stored JSON support.

## Saved tiebreaker clues

The optional JSON `tiebreakers` array contains up to 20 entries, each with `category`, `question`, and `answer` (no dollar value). See the updated [example](examples/question-import.json). The editor can add, remove and reorder them. Incomplete saved clues may be saved as drafts, but must be completed or removed before launch; JSON imports require complete entries. Existing boards/JSON without this key remain valid.

For existing Supabase installations, run [`003_saved_tiebreakers.sql`](supabase/migrations/003_saved_tiebreakers.sql) in SQL Editor after migrations 001 and 002. This updates the generated canonical question JSON and refreshes existing rows without changing game/session versions. Clues are frozen with the session board at launch; editing a saved board never changes a running session. Future clue text/answers are withheld from player and audience views. No clues repeat automatically when the saved queue runs out.

## Screen awake and Final submission overview

Host and player session screens have an optional **Keep screen awake** button, initially Off. **Active** means the browser has granted a screen wake lock. It releases on session end, navigation or disable, and reacquires when returning to a visible page after opting in. Unsupported/insecure browsers show a screen-timeout fallback; browser denials and OS releases show a retryable status. This is a best-effort screen lock, not a guarantee against manual locking, switching apps, power-saving policies or browser suspension. Existing host heartbeat/disconnect pause rules still apply. No sound, scoring, timer or reconnect behavior is changed.

During Final responseing and review, only the host sees **N of M answers saved** and per-player received/blank/missing statuses. The count includes nonblank text already accepted by the server, not unsent keystrokes. Received status and host correctness judgments are separate: a saved answer can be incorrect. Blank answers remain ineligible for Correct. Accepted saves record a server timestamp, including deliberate blank saves; legacy nonblank responses still count without a timestamp. Audience/player projections keep later players' answers hidden until their review turn and never expose another player's submission timestamp. No Supabase migration is required.

During Final review, the audience display shows the current named player's submitted answer and wager before the host judges it. Later players' answers remain hidden until their turn; the correct Final solution is shown first in the preceding Correct response stage, and judging controls remain private to the host. Submission acceptance timestamps stay private. On phones, navigation/connection/mute share one aligned row and the screen-awake control occupies a separate full-width row.

Final response time expiry now opens a **Correct response** screen for everyone before any individual response is revealed. The host selects **Reveal player answers** to start review; this stage survives pause/resume and does not change points or deadlines. In a tiebreaker win, the results screen shows only the winning tiebreaker answer; normal results retain the Final Jeopardy answer. Player layouts use a wider laptop card and card-relative clue typography with bounded timers, while phones keep the compact interface and audience screens retain projection sizes. No database migration is required.

## Clue selection and terminology

Starting play randomly chooses an active player for the first selection. A correct regular or Daily Double response transfers selection to that respondent, even for a zero wager. Misses, timeouts, unanswered clues and host-forced reveals retain the previous selector. Undoing a judgment restores the selector as well as scores. The host continues clicking tiles; the “Next selection” indicator is visible on host, player and audience screens during board play. Practice and Final Jeopardy do not alter board selection. Selection persists across reloads and host resume. Older running sessions without a saved selector use the first active player as a stable fallback until a correct response transfers selection. No migration is required.

UI terminology uses **Clue**, **Correct response**, **Your response**, **Clue value**, **Score** and **Wager**. Saved content is a **Board**; a playthrough is a **Session**. Existing JSON keys (`question`, `answer`), API commands and database fields stay compatible. Response-deadline help distinguishes scored regular misses from unscored tiebreaker misses. Response phrasing remains a host judgment rather than an automatic question-form check.

## Undo judgments within a clue

The host’s **Undo last judgment** button shows the number of remaining checkpoints for the current clue. For example, after Alex and Sam both miss, undo once to return to Sam’s response, then undo again to return to Alex’s response. Each undo restores all scores, attempted-player eligibility, remaining buzzer time, clue completion, applied score events and selection ownership to that checkpoint. Later pending buzzes are canceled. The restored response is judged manually without restarting its spoken-response deadline. Rejudging creates a new checkpoint; undone judgments are removed from the applied CSV score ledger while the action audit remains.

History survives reload, host takeover and pause/resume, and remains available through a forced reveal until the host advances. Advancing off the clue clears it; no undo can reach earlier clues, Final Jeopardy or sudden-death judgments. Old sessions retain their existing single checkpoint, but lost historical judgments cannot be reconstructed. All new judgments use the stack. No database migration is required.

## Player-owned Daily Double wager

A Daily Double belongs to the saved next-selection player. Only that player can save a whole-dollar wager from $0 through their absolute score. The player must select **Save wager**, including for $0; they can update it until locked. Everyone sees the saved amount, while unsaved input remains local. The host selects **Lock wager & reveal clue** after a wager is saved. The server rejects a stale lock if the wager changed since the host’s snapshot, so the host reviews the new amount before retrying. Buzzers remain disabled, and the clue stays hidden until lock. Assignment and saved wagers survive reconnect, host takeover and pause/resume; judgment undo restores the locked wager. Existing pending sessions use their saved selector (or the stable first-active fallback), and existing already-locked Daily Doubles remain judgeable. Refresh all game screens after deployment. No migration is needed.
