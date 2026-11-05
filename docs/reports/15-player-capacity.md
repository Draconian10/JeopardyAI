# Fifteen-player capacity assessment

Test date: November 5, 2026. Application baseline: `298ec4aeb08b8dabe0c5eff2f88189a89fac8fc6`.

**Recommendation: do not certify the current build as reliable for a 15-player game yet.** The buzzer's scoring correctness passed the concurrent test, but simultaneous Final Jeopardy draft saves caused transaction-retry failures. A degraded-transport experiment reproduced a durable **Host disconnected** pause. Vercel and Supabase remain reasonable hosts for one 15-player room; redesigning the hot write path should precede purchasing more capacity.

## What was actually tested

The opt-in harness executes the application's real Next route handlers, request schemas, identity/rate-limit code, game engine, session read/commit retry loops, and all three actual SQL migrations against local PGlite PostgreSQL. It performs concurrent real SQL compare-and-swap commits; it does not replace the engine with a toy game.

The Supabase client transport, user-token verification result, and Realtime callback delivery are emulated. Browser polling and heartbeats follow the current 3-second and 5-second cadences. Final typing attempts a save every 500ms with **at most one in-flight save per player**, as the real player UI does. Broadcasts trigger a snapshot read on each subscriber. The room contains 15 players, one host console and one audience display (17 subscribers, 16 heartbeat writers). The four-player baseline includes the corresponding host and audience views.

Artificial per-operation delays of 10, 100 and 150ms and limits of 64 or 16 outstanding emulated database operations are **scenario inputs, not measured production settings or Supabase connection-pool limits**. The PGlite engine runs locally and serializes its internal work. These timings cannot be extrapolated into a hosted throughput guarantee. Actual Supabase WebSocket quotas, Auth rate limits, Vercel function orchestration, cold starts, CPU limits and Wi-Fi packet loss are not implemented by this simulation. The real request/response network is not part of these local handler timings.

No production gameplay code or SQL migration was changed by this investigation. The read-coalescing variant is an experiment inside the harness only.

## Measured local results

The measured data and complete scenario inputs are preserved in [15-player-capacity.json](15-player-capacity.json). Times below are rounded from that data; these are individual exploratory runs, not confidence intervals.

| Scenario                                                    | Result                                                                                                                                                                                                            |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15 concurrent joins from one IP                             | All 15 succeeded.                                                                                                                                                                                                 |
| Repeat all 15 Join-button requests within the same minute   | 5 succeeded; 10 received HTTP 429. This hits the application's 20/minute shared-IP join limit. Normal return-to-game recovery uses a different path and does not automatically repeat Join.                       |
| 20 clues, 15 simultaneous buzzes per clue                   | Exactly 20 winning buzzes and 280 expected losing-buzz responses; no duplicate score events. Median winning response 33ms; p95 35ms, with a 5ms injected database-operation delay.                                |
| Four players idle, 20 seconds, 10ms/64 slots                | 147 requests, zero errors, no host pause. Heartbeat p95 173ms.                                                                                                                                                    |
| Fifteen players idle, 20 seconds, 10ms/64 slots             | 983 requests, zero errors, no host pause. Heartbeat p95 539ms.                                                                                                                                                    |
| Fifteen players typing, 20 seconds, 10ms/64 slots           | 6,143 requests; 34 HTTP 409 “Game is busy” errors, including 18 heartbeat failures. No host pause; heartbeat p95 2.62s.                                                                                           |
| Fifteen players typing, 20 seconds, 100ms/16 slots          | 1,094 requests; 39 busy errors, including 22 heartbeat failures. Heartbeat p95 13.34s, close to the 15-second boundary. No pause in this run.                                                                     |
| Same slower case, experimental single-flight snapshot reads | 1,003 requests; 37 busy errors. Heartbeat p95 13.20s. Read coalescing alone did not resolve shared-row contention. Separate runs vary; this is not proof that coalescing makes answer acceptance worse or better. |
| Fifteen players typing, 20 seconds, 150ms/16 slots          | 691 requests; 25 busy errors and 22 paused-game errors. Heartbeat p95 20.76s. **Host disconnected pause reproduced.**                                                                                             |
| Explicit 16-second host heartbeat gap                       | The next heartbeat returns HTTP 200 but the session remains durably paused, by the engine's existing disconnect policy.                                                                                           |

The 20-second traffic experiments stop generating new work at 20 seconds and then drain outstanding work. Slow/degraded drains took 5.2/9.2 additional seconds. Counts of nonblank Final answers at the end of these abbreviated experiments **are not a measurement of lost answers at the real 30-second deadline**. Full-length Final trials are recorded separately in the JSON and summarized below.

### Full-length Final trials

| Scenario                        | Requests | Busy failures | Deadline-stage rejections | Nonblank responses persisted at Final reveal | Heartbeat p95 | Host paused?               |
| ------------------------------- | -------: | ------------: | ------------------------: | -------------------------------------------: | ------------: | -------------------------- |
| 30-second Final, 10ms/64 slots  |    8,013 |            70 |                        15 |                                        15/15 |         3.70s | No                         |
| 30-second Final, 150ms/16 slots |      980 |            52 |                        15 |                                         9/15 |        27.82s | No, in this particular run |

The fifteen deadline-stage rejections in each trial are requests queued before expiry but received after the authoritative phase changed. They are expected deadline enforcement, not duplicate scoring or a database-busy classification. In the degraded full-length trial, six players never obtained a successful nonblank save before cutoff; this is a delivery/capacity failure in the injected model, not disappearance of previously accepted answers. The separate degraded 20-second run did pause the host. A slower system can therefore fail by either missing saves or pausing, depending on interleaving. Heartbeat percentiles include host and player heartbeats; they are not a separate host-only latency measurement.

The two full-length trials generated new typing work for thirty seconds and then drained outstanding calls for 0.1s/13.7s. The normal test does not simulate Vercel aborting a function at thirty seconds; the recorded calls in these runs all completed inside that per-request budget.

“Tests passed” means the experiment completed and its correctness assertions passed. It does **not** mean the capacity acceptance criteria passed: load errors are deliberately captured as findings rather than hidden behind a green test result.

## The growth mechanism

In an otherwise idle room with 15 players, host and audience:

- Host plus players: 16 × 12 heartbeats/minute = **192 session commits/minute**.
- Every successful commit broadcasts a version to 17 subscribers: **3,264 delivered notifications and snapshot GETs/minute**.
- Independent 3-second polling adds **340 GETs/minute**.
- Adding heartbeat POSTs gives approximately **3,796 application requests/minute while idle**, before initial loads, joins, gameplay, retries or timer-expiry reads. This is a steady-state formula; a 20-second startup window contains only three completed heartbeat cycles.
- Every authenticated request validates its token through Supabase Auth. Each heartbeat also consumes two rate-limit RPCs, reads the aggregate and writes it back. CAS conflicts cause additional aggregate reads and commit attempts.
- `commit_session` deletes and reinserts every membership row on every accepted heartbeat, and the generated question JSON is recomputed when the state changes. This work is unnecessary for routine presence updates.

Fifteen players can attempt up to 30 Final draft saves/second. Each save currently rewrites the same aggregate, appends an action-history entry/processed ID, and broadcasts to all 17 views. The upper-bound steady rate during typing is roughly **564 delivered events/second and 603 application requests/second**, including heartbeats/polling. Network latency and the one-in-flight-save guard lower actual save throughput; this is an upper bound, not an observed production rate.

The measured 20-second faster Final run made 3,729 commit attempts for 346 commits: **3,383 CAS conflicts**. The harness counted approximately **393MB of serialized private session state read** internally, not 393MB of measured network transfer. Private draft saves are producing public refresh work even though later players' answers must remain hidden.

The host disconnect policy uses 15 seconds since the last persisted host heartbeat. Heartbeat and draft writers compete on the same row, so a delayed heartbeat can be treated as absence. A late successful heartbeat updates `hostSeen` but does not automatically unpause the session; the host must explicitly Continue.

## Hosting findings and limits of the live check

The repository's configured homepage is [lunchandjeopardy.vercel.app](https://lunchandjeopardy.vercel.app/). I made only 30 bounded, read-only live requests:

- 15 concurrent homepage requests: all HTTP 200.
- 15 concurrent unauthenticated `/api/player-sessions` requests: all HTTP 401, as expected.

The probe does not reach authenticated gameplay, Supabase Auth verification or game persistence, and does not establish game capacity. Latencies include this runner's proxy/network path. The routing headers began with `cle1`; a routing header alone does not establish the database's region or all function execution placement.

There is no linked Vercel project configuration or local Supabase credential file in this workspace. The actual Vercel plan, Fluid compute setting, deployment function region, Supabase plan/compute size/region, configured Realtime thresholds, Auth limits, and production logs were not accessible. Repository code exports a 30-second function budget and has no explicit region configuration; dashboard settings may override deployment placement.

Published Supabase defaults currently allow 200 concurrent Realtime connections on Free and 500 on Pro. Seventeen subscribers fit those default connection counts, but that says nothing about write performance or message volume. The published message limits are 100 events/second on Free and 500 on capped Pro; project configuration can differ. Supabase counts deliveries to each subscriber and evaluates the event rate over the preceding minute. At the upper-bound save cadence, one 30-second Final adds about 15,300 delivered events, on top of roughly 3,264 heartbeat events in that minute, which would exceed the Free default event allowance. **The local harness does not emulate that disconnect behavior**, so actual Realtime throttling could introduce another failure mode. No claim is made that a quota was exceeded in the user's production session.

Supabase also defaults anonymous sign-ins to 30 per hour per IP. Repeated fresh private-browser tests on a public Wi-Fi IP can exhaust this separately from the app's join limit. Existing guest identity recovery should be reused rather than creating another anonymous user on every retry. The harness substitutes Auth identity verification and therefore does not test the hosted Auth quota.

## Scaling work in priority order

1. **Move presence off the game aggregate.** Use narrow host-lease/player-presence records, controller-validated host renewal, and indexed timestamps. A heartbeat should not rewrite the board, score/history JSON or membership rows and should not broadcast a game-change event. Update membership only for join/remove changes. Keep durable authoritative disconnect detection and timer freezing.
2. **Store Final drafts per player.** Use rows keyed by session/player with server timestamps and a conditional write that enforces active phase, pause state and deadline. Separate rows avoid all fifteen writers competing for one aggregate. Notify submission-status changes, not every text edit; expose only counts/status to the host until review. Freeze the latest accepted text atomically at the deadline so scoring/review remain reproducible. Preserve ownership, privacy, server deadlines and resume behavior.
3. **Bound snapshot work.** Allow one snapshot fetch in flight per view, retain one trailing refresh, use notification versions to skip already-seen updates, and add jitter/backoff. Poll less often while Realtime is healthy, while retaining explicit deadline, focus, reconnect and degraded-service reconciliation. The coalescing experiment shows this is useful but insufficient by itself.
4. **Make the host lease robust to short delays.** Once heartbeat writes are lightweight, consider a 25–30 second grace window with explicit reconnect feedback. Preserve the original lease-loss instant for timer reconciliation. Increasing the grace alone only hides contention and is not the primary fix.
5. **Keep buzzer arbitration atomic.** The current fifteen-way tests pass. If more rooms or larger games are needed, a narrow SQL claim RPC conditioned on current window, eligibility, deadline and no respondent can reject losing buzzes without repeated read/whole-aggregate CAS loops. Do not replace server ordering with untrusted client timestamps or per-function memory.
6. **Place Vercel functions near Supabase.** Verify actual deployed regions in both dashboards; static CDN placement does not determine the database hop. Use one suitable write region for a room. More Vercel instances or regions do not remove a single-row database bottleneck.
7. **Tune quotas and compute after reducing work.** Check actual Realtime event/connection limits, Auth anonymous signup limits and shared-IP join handling. Retain abuse protection while separating per-user limits from an appropriately sized shared-IP allowance. Upgrade Supabase compute if measured SQL/CPU/IO latency remains high. Upgrade Realtime allowance for multiple simultaneous rooms if delivered-event budgets require it. No exact price or required paid plan can be justified without the account settings and measurements.

For one 15-player room, Redis, a dedicated WebSocket service and a Kubernetes migration are not prerequisites. For many concurrent rooms or much larger games, a dedicated room coordinator or managed realtime transport becomes an option after measuring the improved design. Durable authoritative writes and reconnect recovery must still have a persistence strategy.

## Acceptance before the next game night

Use a separate staging deployment with the same Vercel region/settings and Supabase tier/region as production. Provision fifteen test guest identities and one host, plus one audience view. Keep browser storage between reconnects. Record the following while running repeated 15-way buzzes, a full 30-second Final with all players typing, Daily Double wagering, host close/resume, and a 15-minute game:

- Exactly one accepted buzzer winner per window; no duplicate score deltas or lost accepted answers.
- No unexpected HTTP 429/409/5xx, no heartbeat-starvation pauses while the host is connected.
- Target p95 acknowledged buzz under 500ms and p95 host heartbeat under 2 seconds in the chosen nearby-region network. These are proposed acceptance goals, not guarantees for public Wi-Fi.
- Accepted draft revisions persist across reconnect; rejected/late drafts are clearly distinguished from saved drafts.
- Vercel request duration, timeouts, CPU/memory and function region; Supabase query latency, CPU/IO, locks, Auth 429s and Realtime disconnection/event charts.
- Repeat on the actual venue Wi-Fi and a second network. This separates venue transport effects from server capacity.

The authenticated deployed test requires staging access or an account-side run; it was not performed in this workspace. No credentials should be placed in the report or repository. A successful public-page probe must not be used as production game certification.

## Reproduce the local experiments

```bash
npm ci
npm run test:stress
# A targeted full-length Final trial:
STRESS_SECONDS=30 STRESS_OUTPUT_DIR=test-results/stress-full-final npm run test:stress -- -t '15 players Final answer autosave, (10ms|150ms)'
```

The stress suite is opt-in and excluded from normal `npm test`; it writes machine-readable results to `test-results/stress/results.json` by default. The coalesced-read option is solely an experimental client policy inside the harness. No production account, network request or deployed game is touched by `test:stress`.

## Primary references checked November 5, 2026

- [Supabase Realtime limits](https://supabase.com/docs/guides/realtime/limits)
- [Supabase event accounting and project settings](https://supabase.com/docs/guides/realtime/settings)
- [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits)
- [Vercel function region configuration](https://vercel.com/docs/functions/configuring-functions/region)
- [Vercel concurrency scaling](https://vercel.com/docs/functions/concurrency-scaling)
