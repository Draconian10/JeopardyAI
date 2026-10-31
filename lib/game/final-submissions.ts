import type { FinalEntry } from './types';
export function finalSubmissionStatus(entry?: Partial<FinalEntry>) {
  if (entry?.text?.trim()) return 'Answer saved';
  if (entry?.submittedAt !== undefined) return 'Blank answer saved';
  return 'No answer received';
}
