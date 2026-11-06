'use client';
import type { SessionView } from '@/lib/game/types';
import { ageLabel, contactStatus, type ConnectionHealth } from '@/lib/connection-health';
export default function ConnectionHealthPanel({
  s,
  health,
  now,
  refresh,
}: {
  s: SessionView;
  health: ConnectionHealth;
  now: number;
  refresh: () => Promise<void>;
}) {
  const successful = health.samples.filter((sample) => sample.reachable).map((sample) => sample.ms);
  const sorted = [...successful].sort((a, b) => a - b);
  const recent = successful.at(-1);
  const p95 = sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]
    : undefined;
  // `now` is server-adjusted; request timestamps come from the local clock.
  const localNow = Date.now();
  const stale = health.lastSnapshotAt === undefined || localNow - health.lastSnapshotAt > 20000;
  return (
    <details className="panel connection-health">
      <summary>
        Connection health{' '}
        <span className="health-summary">
          {health.transport === 'realtime'
            ? 'Realtime subscribed'
            : health.transport === 'polling'
              ? 'Fallback polling'
              : 'Connecting'}
          {stale ? ' · Snapshot delayed' : ''}
        </span>
      </summary>
      <div className="health-metrics">
        <div>
          <small>Host console updates</small>
          <strong>
            {health.transport === 'realtime'
              ? 'Realtime + safety polling'
              : health.transport === 'polling'
                ? 'Fallback polling'
                : 'Connecting to Realtime'}
          </strong>
        </div>
        <div>
          <small>Last acknowledged request</small>
          <strong>{ageLabel(health.lastResponseAt, localNow)}</strong>
        </div>
        <div>
          <small>Last game snapshot</small>
          <strong>{ageLabel(health.lastSnapshotAt, localNow)}</strong>
        </div>
        <div>
          <small>Recent request round trip</small>
          <strong>{recent === undefined ? 'Not yet recorded' : `${recent} ms`}</strong>
        </div>
        <div>
          <small>Recent p95 round trip</small>
          <strong>{p95 === undefined ? 'Not yet recorded' : `${p95} ms`}</strong>
        </div>
        <div>
          <small>Failed sync requests, last {health.samples.length} requests</small>
          <strong>{health.samples.filter((sample) => !sample.reachable).length}</strong>
        </div>
      </div>
      <p className="muted small">
        Timings are measured by this host console, including authentication and network time. A
        subscribed channel does not guarantee instant delivery. Player contact below comes from the
        last game snapshot; individual phone latency and screen-awake status are not measured.
      </p>
      <div className="health-player-list" aria-label="Player last contact">
        {s.players.map((player) => (
          <div key={player.id}>
            <b>{player.name}</b>
            <span>{contactStatus(player.lastSeen, now)}</span>
            <span>{ageLabel(player.lastSeen, now)}</span>
          </div>
        ))}
        {!s.players.length && <p>No players have joined yet.</p>}
      </div>
      <button
        type="button"
        className="button secondary small-button"
        onClick={() => void refresh()}
      >
        Refresh connection details
      </button>
    </details>
  );
}
