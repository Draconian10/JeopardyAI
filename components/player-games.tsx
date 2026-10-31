'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, RotateCcw } from 'lucide-react';
import { api, configured, money, supabase } from '@/lib/client';
import type { PlayerSessionSummary } from '@/lib/game/player-sessions';

export default function PlayerGames() {
  const [games, setGames] = useState<PlayerSessionSummary[]>([]);
  const [error, setError] = useState('');
  const [authVersion, setAuthVersion] = useState(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!configured()) return;
    const { data } = supabase().auth.onAuthStateChange(() => {
      setGames([]);
      setAuthVersion((v) => v + 1);
    });
    return () => data.subscription.unsubscribe();
  }, []);
  useEffect(() => {
    if (!configured()) return;
    let alive = true;
    let loading = false;
    const refresh = async () => {
      if (loading) return;
      loading = true;
      try {
        const { data } = await supabase().auth.getSession();
        if (!alive) return;
        if (!data.session) {
          setGames([]);
          setError('');
          return;
        }
        const result = await api<{ sessions: PlayerSessionSummary[] }>('player-sessions');
        if (alive) {
          setGames(result.sessions);
          setError('');
        }
      } catch {
        if (alive) setError('Could not check your active games.');
      } finally {
        loading = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
    };
  }, [authVersion, retry]);
  if (!games.length && !error) return null;
  return (
    <section className="panel player-return" aria-label="Your active games">
      <span className="eyebrow">
        <RotateCcw size={14} /> PICK UP WHERE YOU LEFT OFF
      </span>
      {games.map((game) => (
        <div className="player-return-row" key={game.id}>
          <div>
            <h2>{game.title}</h2>
            <p>
              {game.playerName} · {money(game.score)} ·{' '}
              {game.paused ? 'Paused' : game.phase === 'lobby' ? 'In the lobby' : 'In progress'}
            </p>
          </div>
          <Link className="button primary" href={`/play/${game.id}`}>
            Return to game <ArrowRight size={16} />
          </Link>
        </div>
      ))}
      {error && (
        <div className="button-row">
          <p role="status" className="error">
            {error}
          </p>
          <button type="button" className="text-button" onClick={() => setRetry((v) => v + 1)}>
            Retry
          </button>
        </div>
      )}
    </section>
  );
}
