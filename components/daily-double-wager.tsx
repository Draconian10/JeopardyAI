'use client';
import { useState } from 'react';
import { Star } from 'lucide-react';
import { money } from '@/lib/client';
import type { SessionView } from '@/lib/game/types';
import type { Command } from '@/lib/game/schema';

export default function DailyDoubleWager({
  s,
  player,
  userId,
  control,
  busy,
  connected,
  send,
}: {
  s: SessionView;
  player: boolean;
  userId: string;
  control: boolean;
  busy: boolean;
  connected: boolean;
  send: (command: Command) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(String(s.daily?.amount ?? 0));
  const assigned = s.players.find((p) => p.id === s.daily?.playerId);
  const mine = player && userId === assigned?.id;
  const max = Math.abs(assigned?.score ?? 0);
  const amount = Number(draft);
  const valid = draft.trim() !== '' && Number.isSafeInteger(amount) && amount >= 0 && amount <= max;
  return (
    <section className="question-stage daily-stage">
      <Star size={48} fill="currentColor" />
      <span className="eyebrow">DAILY DOUBLE</span>
      <h2>{assigned ? `${assigned.name} found the Daily Double!` : 'Daily Double!'}</h2>
      <p>One player. One wager. No buzzer.</p>
      <p className="daily-wager-status" role="status" aria-live="polite">
        {s.daily?.submitted
          ? `Saved wager: ${money(s.daily.amount)}`
          : `Waiting for ${assigned?.name ?? 'the selecting player'} to save a wager.`}
      </p>
      {mine && (
        <form
          className="wager-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid && !busy && !s.paused && connected) void send({ type: 'dailyWager', amount });
          }}
        >
          <label>
            Your wager · max {money(max)}
            <input
              type="number"
              min={0}
              max={max}
              step={1}
              required
              value={draft}
              disabled={busy || s.paused || !connected}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button className="button primary" disabled={!valid || busy || s.paused || !connected}>
            Save wager
          </button>
          <p className="muted small">
            Save your wager to share it. You can change it until the host locks it and reveals the
            clue.
          </p>
        </form>
      )}
      {control && (
        <button
          className="button primary"
          disabled={busy || s.paused || !connected || !s.daily?.submitted}
          onClick={() => void send({ type: 'openDaily' })}
        >
          Lock wager &amp; reveal clue
        </button>
      )}
      {!mine && !control && (
        <p className="muted">The host will lock the saved wager and reveal the clue.</p>
      )}
    </section>
  );
}
