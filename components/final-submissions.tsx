import type { SessionView } from '@/lib/game/types';
import { finalSubmissionStatus } from '@/lib/game/final-submissions';
export default function FinalSubmissions({ s }: { s: SessionView }) {
  const players = s.players.filter((p) => !p.removed);
  const saved = players.filter((p) => !!s.finalEntries[p.id]?.text?.trim()).length;
  return (
    <section className="final-submissions" aria-label="Final answer submissions">
      <h3 aria-live="polite">
        {saved} of {players.length} answers saved
      </h3>
      <p>
        Nonblank answers received by the server. Saving an answer does not mean it is correct.{' '}
        {s.phase === 'finalAnswer'
          ? 'Only answers received before the deadline count.'
          : 'Submissions are locked.'}
      </p>
      <ul>
        {players.map((p) => {
          const entry = s.finalEntries[p.id];
          return (
            <li key={p.id}>
              <b>{p.name}</b>
              <span>
                {finalSubmissionStatus(entry)}
                {entry?.judged
                  ? ` · Judged ${entry.correct ? 'correct' : 'incorrect'}`
                  : ' · Not judged'}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
