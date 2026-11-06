import { expect, it } from 'vitest';
import { ageLabel, contactStatus, initialHealth, observeRequest } from '@/lib/connection-health';
it('bounds diagnostics and keeps failed reads from refreshing snapshot age', () => {
  let h = observeRequest(initialHealth, 'snapshot', 30.4, true, 1000);
  for (let i = 0; i < 30; i++) h = observeRequest(h, 'command', 10, true, 2000 + i);
  h = observeRequest(h, 'snapshot', 12000, false, 9000);
  expect(h.samples).toHaveLength(20);
  expect(h.lastResponseAt).toBe(2029);
  expect(h.lastSnapshotAt).toBe(1000);
  expect(h.transport).toBe('connecting');
});
it('describes recorded contact rather than asserting device connectivity', () => {
  expect(contactStatus(10000, 15000)).toBe('Seen recently');
  expect(contactStatus(10000, 35000)).toBe('Contact delayed');
  expect(contactStatus(10000, 60000)).toBe('No recent contact');
  expect(ageLabel(undefined, 1000)).toBe('Not yet recorded');
  expect(ageLabel(2000, 1000)).toBe('0s ago');
});
