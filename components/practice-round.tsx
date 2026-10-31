'use client';
import { Zap, RotateCcw, ArrowRight } from 'lucide-react';
import type { Command } from '@/lib/game/schema';
import type { SessionView } from '@/lib/game/types';
export default function PracticeRound({
  s,
  player,
  userId,
  control,
  busy,
  connected,
  remaining,
  timer,
  send,
}: {
  s: SessionView;
  player: boolean;
  userId: string;
  control: boolean;
  busy: boolean;
  connected: boolean;
  remaining: number;
  timer: React.ReactNode;
  send: (command: Command) => Promise<boolean>;
}) {
  const open = s.phase === 'practiceOpen';
  const winner = s.players.find((p) => p.id === s.respondent);
  const ready = open && remaining > 0 && !s.paused && connected && !busy;
  return (
    <section className={`panel practice-stage ${player ? 'practice-player' : ''}`}>
      <span className="badge">PRACTICE · NO POINTS</span>
      <h2>Practice buzzer round</h2>
      <p className="muted">
        Test your buzzer and connection. Scores and board questions are unchanged.
      </p>
      {open && timer}
      {player && (
        <button
          className={`buzzer ${ready ? 'ready' : ''} ${winner?.id === userId ? 'won' : ''}`}
          disabled={!ready}
          onClick={() => {
            if (s.windowId) void send({ type: 'buzz', windowId: s.windowId });
          }}
        >
          <Zap size={42} fill="currentColor" />
          <b>
            {busy
              ? 'CHECKING…'
              : winner?.id === userId
                ? 'YOU’RE UP!'
                : ready
                  ? 'BUZZ!'
                  : 'HOLD TIGHT'}
          </b>
        </button>
      )}
      <p className="practice-result" role="status">
        {s.paused
          ? 'Practice is paused.'
          : winner
            ? `${winner.name} buzzed first!`
            : open
              ? 'Buzzers are open. Try it now.'
              : 'Practice time is up. Your host can open another round.'}
      </p>
      {control && (
        <div className="button-row centered">
          <button
            className="button secondary"
            disabled={busy || s.paused}
            onClick={() => void send({ type: 'practiceStart' })}
          >
            <RotateCcw size={16} />
            Reset practice buzzer
          </button>
          <button
            className="button primary"
            disabled={busy || s.paused}
            onClick={() => void send({ type: 'practiceStop' })}
          >
            Finish practice <ArrowRight size={16} />
          </button>
        </div>
      )}
      {!player && !control && (
        <p className="muted small">The host can reset the buzzer or finish practice.</p>
      )}
    </section>
  );
}
