# Scalable runtime rollout and validation

This change removes heartbeats and per-keystroke Final saves from the shared session write path. It preserves host control/PIN takeover, server deadlines, scoring, clue-scoped undo, Daily Double ownership/wagers, Final review, tiebreakers, CSV results and guest reconnection.

## Deployment order

1. Choose a maintenance interval with active games paused. Verify changes in a separate staging Supabase project/deployment first. Keep an appropriate database backup.
2. In the target project's Supabase SQL Editor, apply unapplied migrations **001, 002, 003, then 004_scalable_runtime.sql**. Apply each once. Migration 004 is transactional, adds private runtime tables, backfills presence/accepted responses/action receipts and replaces the commit function. It does not delete games, scores or session history.
3. Wait for PostgREST's schema-cache refresh (the migration sends a reload notification). Deploy/merge the matching application only after the migration succeeds. An incompatible deployment returns an explicit migration-required message; it does not silently fall back to the previous high-contention path.
4. Refresh all host, player and audience tabs. Reopen the same sessions; use the existing host PIN/Continue flow if needed. Verify retained scores, join code and saved Final submissions. Existing aggregate-based saves remain supported during the brief rollout overlap, but refresh tabs to use the revision-aware receipt protocol.
5. Keep `session_presence`, `session_final_drafts` and `session_final_receipts` private. They need no browser select policy, public channel, or Postgres Changes publication. Existing private Broadcast authorization through `session_members` remains in effect.

No new environment variable or package is required. Match the Vercel function's actual region to the Supabase project's region using the dashboards; the workspace does not contain account settings or credentials to select that region on the user's behalf. A static CDN routing header is not proof of database placement.

Do not deploy an older server after adopting the new protocol as a permanent rollback strategy: the tables retain authoritative private drafts, so preserve them and use a compatible app version. The migration has a compatibility path for the immediately preceding aggregate-save deployment during rollout. If migration application fails, its transaction rolls back; retain the old app until the error is resolved.

## What changed

| Path                  | New behavior                                                                                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Host/player heartbeat | One narrow presence update; no aggregate commit, score/history rewrite, membership rebuild, or game broadcast.                                                                                                                                                                                         |
| Host lease            | 30-second grace, controller-validated renewal, immediate foreground/online renewal. A genuine expired lease freezes at the original loss boundary and requires Continue after recovery.                                                                                                                |
| Final save            | A private row per player, own revision and action receipt, server timestamp, ownership/pause/deadline checks.                                                                                                                                                                                          |
| Final freeze          | Exclusive phase transition captures every draft accepted before the boundary, including a save accepted after the host's snapshot was read.                                                                                                                                                            |
| Submission overview   | Initial or blank/nonblank status changes notify views; ordinary text edits do not fan out private response refreshes.                                                                                                                                                                                  |
| Snapshots             | One request in flight plus one trailing refresh, version deduplication, runtime timestamp ordering, and protection for acknowledged own revisions. Healthy Realtime polls roughly every 10s; fallback polls roughly every 3s, both with jitter. Deadline and focus recovery still request fresh state. |
| Buzzer                | Engine checks plus a conditional transactional claim. Exactly one winner; losers do not spin through aggregate retries.                                                                                                                                                                                |
| Shared public IP      | Join limits retain per-user protection while allowing a larger shared-IP budget for a group and bounded retries. Supabase's separate anonymous Auth quota still needs account-side verification.                                                                                                       |
| Player messages       | Brief uncertainty uses “Reconnecting to host — your progress is saved.” A genuine pause remains visible with preserved progress.                                                                                                                                                                       |

Session API calls also have bounded timeouts: 8s for heartbeat, 12s for snapshots and 15s for gameplay/draft commands (30s for other API calls). The bound includes waiting for Auth token refresh. A stalled call releases the single-flight slot, and a late Auth completion cannot send a ghost request. Autosave stops when the displayed deadline reaches zero; already-sent requests are still judged by the server deadline.

A network outage, manually locked device, suspended host browser or exhausted provider quota can still require recovery. The fix prevents presence from being starved by draft writes; it cannot guarantee uninterrupted connectivity on every public Wi-Fi network.

## Validation

The regular suite includes real PostgreSQL/PGlite migration, role/permission, private-receipt, draft-revision, duplicate/replayed request, stale-controller, phase-freeze race, compatibility, membership and pause/resume cases. Browser tests exercise receipt-based saves, protection against stale snapshots, queued read recovery, focus bursts, host/player/audience controls and the existing gameplay flows.

The opt-in stress suite executes the actual API handlers and SQL against local PGlite with injected transport delays, not an actual Vercel/Supabase deployment. It tests fifteen-way joins/buzzes, full Final typing, slow operations, real lease loss and three independent rooms. It preserves the original experiment report as historical baseline. New model assertions require all responses to persist, no false host pause and no unexpected busy/permission/server errors; post-deadline “Responses are locked” rejections are expected and counted separately.

Measured November 6, 2026; all ten stress scenarios passed. Full inputs and observations are in [scaled-15-player-results.json](reports/scaled-15-player-results.json). Each single-room traffic run lasted 30 seconds, with full Final deadlines where applicable. Heartbeat timings combine host and player renewals; they are not host-only measurements.

| Scenario                                                          | Observed result                                                                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15 joins, then 15 repeated joins from one IP                      | All 30 requests succeeded.                                                                                                                        |
| 20 rounds of 15 simultaneous buzzes                               | Exactly 20 winners, 280 expected losers, no duplicate score events.                                                                               |
| 15-player idle room                                               | 147 requests, all successful; no game commits or broadcasts and no false pause.                                                                   |
| 15-player Final, 10ms operation delay / 64 slots                  | 1,083 requests, all successful; 15/15 responses retained; heartbeat p95 86ms.                                                                     |
| 15-player Final, 100ms / 16 slots                                 | 1,008 requests, all successful; 15/15 retained; heartbeat p95 686ms.                                                                              |
| 15-player Final, 150ms / 16 slots                                 | 648 requests; 15 expected post-deadline save rejections; 15/15 retained; heartbeat p95 699ms; no false pause.                                     |
| Three rooms, 45 players and 51 subscribed views, 100ms / 16 slots | 60-second observation: all 45 responses retained, zero false pauses/unexpected errors; one expected post-deadline rejection; heartbeat p95 1.91s. |
| Deterministic 31-second host lease gap                            | Durable pause at the correct boundary; recovery does not silently skip the pause.                                                                 |

The separate uncoalesced-read experiment also passed (1,185 requests); it is retained for comparison. The earlier degraded full-Final baseline retained 9/15 responses and recorded 52 busy failures, while this degraded model retained 15/15 with none. These are separate exploratory runs with changed protocol/client behavior, not a controlled production benchmark. A rejected late edit does not imply loss of an earlier accepted response. The three-room test covers one minute, not a long-running soak.

The release regression suite passed 175 unit/database/API tests and 132 desktop/mobile browser tests. Formatting, TypeScript and the production build also passed.

The checked-in results are exploratory model runs, not production certification. Provider Auth verification/Realtime transport, account quotas, Vercel orchestration/cold starts and Wi-Fi loss remain outside the local simulation. The account's actual plan/region/metrics were unavailable. An authenticated staging/venue test and 30–60 minute real-time soak remain required before claiming deployment reliability; no such production soak is claimed here.

## Run locally

```bash
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:e2e
STRESS_SECONDS=30 STRESS_OUTPUT_DIR=test-results/scaled-stress npm run test:stress
```

The stress suite uses local synthetic accounts and never calls a deployed project. For staging, use fifteen retained test guest identities plus a host and audience view. Exercise simultaneous buzzes, Daily Double, Final autosave and review, host close/reopen, pause/resume, removal and results download. Record host lease renewal latency, request failures, query/lock/CPU/IO metrics and Realtime event rates. Test the venue Wi-Fi and a separate network. Scale provider compute/quotas based on those measurements after reducing unnecessary work.
