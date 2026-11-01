import type { FinalEntry } from './types';
export function finalSubmissionStatus(entry?: Partial<FinalEntry>) {
  if (entry?.text?.trim()) return 'Response saved';
  if (entry?.submittedAt !== undefined) return 'Blank response saved';
  return 'No response received';
}
