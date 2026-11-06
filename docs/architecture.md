# Architecture

## Trust boundaries

Browsers authenticate using Supabase Auth. Every API request validates the access token with `auth.getUser()`. Hosting requires a non-anonymous account; guests can act only as their own authenticated player identity. The server service-role credential is used only in server modules. Server modules are never imported by client components.

The persisted session contains the frozen board and private answers. Neither browser table reads nor Realtime broadcasts expose that JSON. `viewSession` constructs explicit role-specific projections. A player's private Final answer/wager remains visible only to that player and the host until that player's Final review turn. The host's audience view is sanitized by the server, not merely hidden with CSS.

## Authoritative state and atomic actions

A session is a durable JSON aggregate with an incrementing database `version`. Each command:

1. Authenticates and validates a strict Zod schema.
2. Loads the current aggregate.
3. Reconciles deadlines/host disconnection against server time.
4. Runs the pure state transition with membership, role, phase, controller, wager, and deadline checks.
5. Calls `commit_session(id, expectedVersion, nextState)`.
6. Returns success only after the transaction commits.

The PostgreSQL function conditionally updates the expected version, refreshes memberships only when membership changes, and broadcasts a version notification for gameplay. If a competing write wins, safe commands reload/retry. A buzzer loser sees the accepted respondent instead of creating another winner. Requests delayed beyond a reopened window cannot buzz because each window has a new UUID.

Host actions also carry a gameplay `actionVersion` to reject stale judgments or phase transitions. Heartbeats update separate presence rows and advance neither version, so ordinary liveness writes do not invalidate a host's pending judgment or contend with gameplay commits.

Mutating requests carry action UUIDs. Durable processed IDs prevent double scoring on replay. Score events record applied deltas. A separate action history records transitions and corrections without storing PINs or duplicating answer text. Undo pops a durable, clue-scoped judgment stack. Later buzzes retain earlier checkpoints; advancing off the clue clears the stack.

## Phases

```mermaid
stateDiagram-v2
  [*] --> Lobby
  Lobby --> Board: Host starts
  Board --> Question: Regular tile
  Question --> Answering: Accepted buzz
  Answering --> Question: Incorrect / time remains
  Answering --> Reveal: Correct / everyone missed
  Question --> Reveal: Time expired
  Board --> DailyWager: Daily Double
  DailyWager --> DailyAnswer: Wager locked
  DailyAnswer --> Reveal: Host judgment
  Reveal --> Board: Tiles remain
  Reveal --> FinalWager: Board complete
  FinalWager --> FinalAnswer: Host locks wagers
  FinalAnswer --> FinalReveal: 30 seconds expire
  FinalReveal --> FinalReview: Host reveals player answers
  FinalReview --> Finished: Unique leader
  FinalReview --> TieSetup: Leaders tied after judging
  TieSetup --> TieQuestion: Host presents clue
  TieQuestion --> TieAnswer: Eligible leader buzzes
  TieAnswer --> TieQuestion: Miss with time and eligible players
  TieQuestion --> TieReveal: Time expires
  TieAnswer --> TieReveal: All missed
  TieReveal --> TieSetup: Another clue
  TieAnswer --> Finished: Correct response
```

Pause is an independent flag, preserving the underlying phase. Explicit End transitions any unfinished phase to `ended`. Finished/ended sessions are historical records.

## Clocks and disconnects

The server uses epoch-millisecond deadlines. The UI estimates its server clock offset from snapshots and renders a local countdown. The server validates submissions independently of that countdown.

During spoken answers, time is stored as remaining milliseconds. Host loss is effective at `hostSeen + 30 seconds`. Reconciliation first resolves any deadline before that boundary, then pauses. If nobody is connected, reconciliation happens on the next request using the same historical boundary. There is no unreliable process-memory timer or browser `beforeunload` dependency.

Realtime notifications trigger authorized snapshot fetches. Single-flight reads, a trailing refresh, 10-second healthy-Realtime polling / 3-second degraded polling with jitter, deadline fetches, focus/online listeners, and game-version/runtime-snapshot checks recover dropped/out-of-order messages. Notifications are best effort: a Realtime outage cannot roll back a committed gameplay action.

## Controller ownership

Each reopened host console gets a fresh controller UUID; a newly launched console consumes its one-use controller handoff instead. Claim requires host account ownership plus the session's hashed six-digit PIN. Claim pauses the session, changes the controller UUID, and refreshes host liveness. The host must select Continue. Old controllers cannot heartbeat or issue host commands. Audience windows never claim control or keep the host alive.

## Rate limiting and limits

Atomic database buckets enforce PIN attempts, joining, saving, commands, and answer writes. Buckets use HMAC-hashed account/IP identifiers. Command/answer IP limits allow multiple phones behind one router; PIN and join attempts retain tighter shared-IP limits. Supabase Auth has its own authentication rate limits; configure its abuse protections for public deployments.

Session JSON is intentionally simple and suitable for casual rooms. Presence and Final drafts now use private normalized tables. For larger numbers of players or rooms, measure the remaining score/attempt CAS contention, and introduce a dedicated room coordinator if latency objectives require it. Keep server-authoritative arbitration and durable state even if the transport changes.

## Category-based question JSON

The editor can validate pasted JSON through the authenticated `POST /api/games/import` endpoint. Shared schemas enforce a complete rectangular board, bounded values/text, unique category names, one Daily Double, and Final Jeopardy before conversion to internal question IDs. Validation does not write or start a game; applying the returned board uses the existing version-protected save/autosave path.

Migration `002_question_json.sql` adds stored generated `question_json` columns to saved games and sessions. PostgreSQL builds them from the authoritative board in category/row order, automatically backfilling old records and updating the saved representation after every visual edit or duplication. The session representation derives from its frozen session board. This avoids storing conflicting copies of pasted JSON and manually edited questions. Private answer access remains unchanged; the generated columns are not part of player or audience projections.

## Practice, answer deadlines, dashboard ending, and standings

Practice uses separate `practiceOpen`, `practiceAnswer`, and `practiceReady` phases. Buzzes use the same atomic window arbitration, while score events and board tile consumption remain untouched. Host resets generate a fresh window ID, and Finish Practice returns to the lobby.

An optional `answerLimitSeconds` session setting defaults to zero for backward compatibility. After a normal buzz, `answerDeadline`/`answerRemaining` run independently from the paused question buzzer time. Reconciliation processes answer expiry at the authoritative deadline instant, then processes any subsequent buzzer expiry up to the host-disconnect boundary. A deterministic timeout event ID, cleared deadline, and CAS commit prevent repeat deductions. Pause/claim freeze both clocks. Undo restores the prior respondent and score but leaves further judgment manual.

`POST /api/sessions/:id/end` requires a permanent authenticated host, stored session ownership, an action UUID, and explicit confirmation. Only this route supplies the internal `dashboardEnd` context to bypass PIN/controller/version requirements for the terminal End action. Client command envelopes cannot supply that context; engine ownership checks remain mandatory. Retried terminal ends are no-ops.

Standings use a shared ranking calculation and keyed DOM rows. A layout effect animates each row from its previous offset to its new offset, including pre-question positions on the reveal screen, without changing authoritative ordering or scores. Heartbeat-only refreshes do not restart animation. Reduced-motion preferences disable movement.

## Connection error lifecycle and confetti

`useSession` tracks synchronization errors separately from action/validation errors. A successful authorized snapshot clears synchronization errors and restores the connection indicator without erasing gameplay errors. A monotonically increasing request sequence orders connection outcomes across refresh and command requests, so delayed failures from older requests cannot undo a newer recovery. Focus/online/visible-page listeners work independently of the Realtime subscription, including for read-only hosts.

Final confetti is a client-only canvas overlay with bounded particle count, capped device-pixel ratio, a short animation lifetime, and cleanup of animation frames/listeners on completion or unmount. Session storage prevents repeated bursts on result refresh; reduced-motion preferences suppress it, including when enabled during the animation. The effect is decorative, silent, hidden from assistive technology, and pointer-transparent.

## Launch control handoff and results exports

The launch request carries a validated controller UUID alongside its existing idempotent request ID. After PIN verification, `createSession` includes that controller in the state passed to the atomic `launch_session` transaction. Retries return the existing session ID without changing control or pausing the session. The client hands the UUID to the destination console once using session storage (with an in-memory navigation fallback), consumes/removes it on mount, and waits for controller initialization before fetching host state. Reloads create a fresh UUID and retain the claim/PIN/Continue protection; Strict Mode effect replay retains the same initialized controller. The host PIN is never stored in this handoff.

`GET /api/sessions/:id/results` requires a permanent authenticated host, exact stored host ownership, and a finished/ended phase. It returns a private, noncached CSV attachment built from persisted players, played questions and the surviving score event ledger. Undo removes superseded score events, so exports follow corrected scores rather than replaying the action audit. Questions with no score events still get zero-change summaries; removed players are included without a rank. Event order and cumulative scores are preserved; text cells are quoted and formula-like strings neutralized while numeric negative scores remain numeric. The export does not serialize private state, PIN hashes, answers or unrevealed board questions, and needs no controller claim or database migration.

## Sudden-death state and display scopes

`finish` after complete Final review snapshots the tied active leaders into `tiebreaker.playerIds` and enters `tieSetup` when necessary. Host-authored clues are strictly validated, privately stored in the durable session, and opened through `tieClue`. `buzz` reuses atomic CAS/window arbitration but permits only those leaders and records one attempt per clue. `tieJudge` records an attempt without a ScoreEvent or money change; only a correct judgment sets the persistent winner and `finished`. All misses/time expiry enter `tieReveal`; `tieNext` keeps every original tied leader eligible for the new clue. Host reveal can abandon a clue without declaring a winner. Clue and optional answer clocks freeze on pause/claim and reconcile with the existing host-loss boundary; answer timeout is a miss without a deduction. Resume, CSV, ranking, winner display and confetti honor the saved tiebreaker outcome. Existing terminal sessions remain historical; new ties use sudden death.

`viewSession` omits clue text during regular/tiebreaker answering and excludes private tiebreaker answers from players/audience before reveal. Only the current round is projected; preparing the next clue does not leak previous private round data. No unrevealed tiebreaker answer is broadcast.

Action errors are scoped to phase, question ID, current tiebreaker round and buzzer window. Accepting a newer stage clears errors; late action failures from the old scope are ignored. Successful synchronization of the same stage still preserves applicable validation errors. Projection typography uses responsive sizes and wrapping rather than clipping or shrinking long clues to unreadable text.

## Saved tiebreaker queue

Optional `board.tiebreakers` holds at most 20 category/prompt/answer objects and is copied into each immutable session board. Portable JSON uses `question` in place of `prompt`. Both conversion directions and migration 003's generated-column function preserve this optional key and its order. Old boards without the key remain valid. Draft editor entries can be incomplete, while `playable` and JSON import require complete saved clues. Column resizing preserves the list.

The strict host-only `tieSavedClue` command atomically reads the next frozen clue using `tiebreaker.savedCluesUsed`, advances the counter and opens the existing sudden-death buzzer phase. Retries use the existing action-ID deduplication; stale versions cannot consume extra clues. Custom clues do not advance the saved queue. The consumed position survives pause, takeover and reload. Host projections expose remaining count/next category only, and no future clue content is included in player/audience projections. An exhausted queue rejects another saved launch, exposing custom entry instead of repeating clues. Migration 003 recomputes existing stored JSON values without changing authoritative gameplay/version fields or access policies.

## Wake locks and received Final answers

`KeepAwake` is an opt-in client capability on unfinished host/player sessions. Generation tokens invalidate requests after cancel, visibility loss or unmount, releasing late-granted sentinels. A release listener reports actual ownership; visibility listeners reacquire only while opted in. OS denial/release never mutates authoritative state. Unsupported contexts fall back to device timeout guidance. Browser capability tests use mock sentinels; physical device/power-policy behavior remains browser controlled.

Accepted `answer` commands set optional `FinalEntry.submittedAt` from server context without changing deadline, pause, scoring or judgment rules. The host-only overview derives nonblank counts from the latest authorized snapshot and distinguishes missing from received blank text. Existing records with nonblank text remain recognized. Submission timestamps remain private to the host and submitting player. Submission counts remain host-only; public answer disclosure follows the review-turn rule below. No database migration is needed.

Final review's `finalReviewPlayer` now defines the public reveal boundary for that one answer/wager. `viewSession` exposes the current entry plus previously judged entries, retaining privacy for future entries and the canonical Final solution. Other players/audience never receive another player's submission timestamp. The audience renderer displays this selected response without private host-answer details or judging controls. Final answering remains private; judgment order, scoring and deadlines are unchanged.

`finalAnswer` expiry transitions to durable `finalReveal`, publishing the canonical Final solution without a `finalReviewPlayer` or other players' responses. The strict host-only/versioned `reviewFinal` action advances to the existing review order. Pause/claim/continue preserve the solution stage; answer writes and judgments remain rejected there. Existing records already in `finalReview` stay compatible. Final results choose one answer block based on the saved tiebreaker winner. Player container width and typography are scoped independently of audience projection styles, with a flexible category column and nonshrinking bounded timer.

## Next clue selection

`Session.nextSelectorId` is optional for legacy JSON. The server chooses the first active selector using rejection-sampled Web Crypto randomness when accepting `start`; reads, retries, practice and resume never reroll. Correct regular/Daily Double judgments update the field independently of monetary delta. Misses/reveals retain it, and undo snapshots restore it. `SessionView` exposes only the selector ID; all views resolve the safe public player name. Legacy sessions use their first active seat as a deterministic fallback, persisted on the next tile selection. Tile commands remain host/controller/version guarded.

## Clue-scoped undo stack

`Session.undoStack` stores one private `JudgmentCheckpoint` before each regular/Daily Double judgment, including timeouts. Every checkpoint includes its clue ID, scores, applied-event length, attempted players, respondent, remaining buzzer time, completed tiles, wager and next selector. `undo` accepts current-clue checkpoints only in question/answering/dailyAnswer/reveal, pops one checkpoint and returns to manual response judging with both clocks stopped. Consecutive undo commands can traverse different players’ responses; rejudging creates a new branch. Accepted later buzzes and forced reveal do not discard the stack. Selecting/advancing clues, practice reset and terminal/session-end transitions clear it. Existing host/controller/version/action-ID/CAS guards prevent unauthorized or duplicate pops. Public projections expose neither snapshots nor counts; the host receives `canUndo` and `undoCount` only. Legacy `undo` is adopted as one checkpoint on first use; already discarded history cannot be recovered. No SQL migration is needed.

## Daily Double ownership and lock

On Daily Double selection, the authoritative selector is frozen in `daily.playerId` with `amount: 0, submitted: false`. Strict player-only `dailyWager` carries an amount and cannot nominate another seat; it checks ownership, phase, whole-dollar schema bounds and absolute score, and updates the publicly visible saved wager without revealing the clue. Host/controller-only `openDaily` requires a submitted valid wager and transitions to `dailyAnswer`. Both use existing actionVersion/CAS/dedup guards, so a concurrent wager save invalidates a stale host lock. `submitted` distinguishes an explicit $0 from no submission. Legacy pending records resolve the saved selector without mutation on reads; old `dailyAnswer` records do not require the new flag. Private snapshots and clue answers retain their existing projection boundaries. Undo preserves amount/ownership/submission state. No SQL change is required.

## Scalable runtime (migration 004)

`session_presence` contains narrow per-user presence rows. Host renewals verify the current controller while locking only the lease row; player renewals cannot renew the host. Aggregate commits use the same host-lease lock before the root lock to serialize takeovers and reject stale false-disconnect proposals. Normal heartbeats return small acknowledgements, never update the aggregate/version/history/membership and never broadcast. A late host heartbeat first reconciles the original 30-second lease-loss boundary and then renews; it cannot silently skip a historical pause. Reconnection remains explicit Continue.

`session_final_drafts` is keyed by session/player. `save_final_draft` uses shared phase locks plus an exclusive per-player draft lock, server timestamps, monotonic revisions and private durable `session_final_receipts` for retries, including replays older than the latest draft. Ownership, pause, host lease and deadline checks run in SQL. Drafts do not change aggregate versions or append action history. Only initial submission / blank-vs-nonblank transitions broadcast a status signal. Phase-changing aggregate commits take the exclusive root lock and hydrate the latest accepted drafts before persistence, preventing a stale host snapshot from dropping an accepted response. Runtime reads overlay current presence and drafts for existing pure-engine authorization/scoring/projection. Judged/frozen responses and the score ledger remain in the aggregate. Legacy aggregate answer saves are synchronized during migration-first rollout.

`claim_session_buzz` conditionally validates version/window/phase/respondent/eligibility and uses the guarded commit; a losing claim rejects directly instead of retrying. The pure engine still defines gameplay transitions and scoring. Private runtime RPCs and tables have RLS and deny anonymous/authenticated direct access; only the server service role executes them. SQL exceptions from notification delivery do not undo an accepted save.

Heartbeat and answer API responses are narrow receipts, not full snapshots. The client preserves acknowledged own-response revisions across older in-flight reads, coalesces pending reads, ignores already-seen version signals, and renews immediately on foreground/online events. `runtimeAt` orders metadata snapshots independently of gameplay `version`. Background polling remains active during Realtime failure. Bounded API timeouts include token refresh and release stalled single-flight slots; aborted token refreshes cannot send late requests. Autosave stops at the local deadline while the database remains authoritative. See [rollout and validation](scaling-runtime.md).
