'use client';
import { useLayoutEffect, useRef } from 'react';
import { Trophy } from 'lucide-react';
import { money } from '@/lib/client';
import { rankedStandings } from '@/lib/game/standings';
import type { SessionView } from '@/lib/game/types';

export default function Standings({ s, compact = false }: { s: SessionView; compact?: boolean }) {
  const rows = rankedStandings(s);
  const elements = useRef(new Map<string, HTMLDivElement>());
  const positions = useRef(new Map<string, number>());
  const animations = useRef<Animation[]>([]);
  const signature = JSON.stringify([
    s.phase,
    rows.map(({ player, delta, movement }) => [player.id, player.score, delta, movement]),
  ]);
  useLayoutEffect(() => {
    animations.current.forEach((a) => a.cancel());
    animations.current = [];
    const next = new Map<string, number>();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    rows.forEach(({ player, movement }) => {
      const el = elements.current.get(player.id);
      if (!el) return;
      const top = el.offsetTop;
      next.set(player.id, top);
      const previous = positions.current.get(player.id);
      const distance = previous !== undefined ? previous - top : movement * el.offsetHeight;
      if (!reduced && distance && typeof el.animate === 'function')
        animations.current.push(
          el.animate([{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }], {
            duration: 650,
            easing: 'cubic-bezier(.22,1,.36,1)',
          }),
        );
    });
    positions.current = next;
    return () => {
      animations.current.forEach((a) => a.cancel());
    };
    // Identity/score changes drive motion; heartbeat-only updates do not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const showChanges = ['reveal', 'finalReview', 'finished'].includes(s.phase);
  return (
    <div className={`standings ${compact ? 'compact' : ''}`}>
      <div className="section-line">
        <h2>
          <Trophy size={18} />
          {s.phase === 'finished' ? 'Final standings' : 'Standings'}
        </h2>
      </div>
      <div className="standings-rows" aria-live="polite" aria-atomic="true">
        {rows.map(({ player: p, rank, delta, movement }) => (
          <div
            className={`standing-row ${rank === 1 ? 'leader' : ''}`}
            key={p.id}
            data-player-id={p.id}
            ref={(el) => {
              if (el) elements.current.set(p.id, el);
              else elements.current.delete(p.id);
            }}
          >
            <span className="rank">{rank === 1 ? <Trophy size={17} /> : rank}</span>
            <span className="player-avatar">{p.name.slice(0, 1).toUpperCase()}</span>
            <div className="standing-name">
              <b>{p.name}</b>
              {s.phase === 'lobby' && (
                <small>{s.serverNow - p.lastSeen < 15000 ? 'Connected' : 'Away'}</small>
              )}
            </div>
            <div className="standing-score">
              <b key={p.score} className="score-value">
                {money(p.score)}
              </b>
              {showChanges && (
                <small className={delta < 0 ? 'negative' : delta > 0 ? 'positive' : 'muted'}>
                  {delta ? `${delta > 0 ? '+' : ''}${money(delta)}` : '—'}{' '}
                  {movement !== 0 && (
                    <span
                      className="rank-movement"
                      aria-label={`Moved ${movement > 0 ? 'up' : 'down'} ${Math.abs(movement)} ${Math.abs(movement) === 1 ? 'place' : 'places'}`}
                    >
                      {movement > 0 ? '↑' : '↓'} {Math.abs(movement)}
                    </span>
                  )}
                </small>
              )}
            </div>
          </div>
        ))}
      </div>
      {!rows.length && <p className="muted">Your contenders will appear here.</p>}
    </div>
  );
}
