export type Transport = 'connecting' | 'realtime' | 'polling';
export interface ConnectionHealth {
  transport: Transport;
  lastResponseAt?: number;
  lastSnapshotAt?: number;
  samples: { ms: number; reachable: boolean }[];
}
export const initialHealth: ConnectionHealth = { transport: 'connecting', samples: [] };
/** Local observations only. Never changes game connectivity, scores, clocks or host leases. */
export function observeRequest(
  health: ConnectionHealth,
  kind: 'snapshot' | 'command',
  ms: number,
  reachable: boolean,
  at: number,
): ConnectionHealth {
  return {
    ...health,
    lastResponseAt: reachable ? at : health.lastResponseAt,
    lastSnapshotAt: reachable && kind === 'snapshot' ? at : health.lastSnapshotAt,
    samples: [...health.samples, { ms: Math.max(0, Math.round(ms)), reachable }].slice(-20),
  };
}
export function contactStatus(lastSeen: number, now: number) {
  const age = Math.max(0, now - lastSeen);
  return age < 20000 ? 'Seen recently' : age < 45000 ? 'Contact delayed' : 'No recent contact';
}
export function ageLabel(at: number | undefined, now: number) {
  return at === undefined ? 'Not yet recorded' : `${Math.floor(Math.max(0, now - at) / 1000)}s ago`;
}
