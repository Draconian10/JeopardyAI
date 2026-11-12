'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Zap, Users } from 'lucide-react';
import { api, configured, supabase } from '@/lib/client';
import { SetupNotice } from './auth';
import { isHostPlayerConflict } from '@/lib/auth-flow';
import PlayerGames from './player-games';
import RecoveryJoin from './recovery-join';
export default function Join() {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [hostConflict, setHostConflict] = useState(false);
  const router = useRouter();
  useEffect(() => {
    const incoming = new URLSearchParams(window.location.search).get('code');
    if (incoming && /^\d{6}$/.test(incoming)) setCode(incoming);
  }, []);
  if (!configured()) return <SetupNotice />;
  return (
    <div className="join-page">
      <div className="join-intro">
        <span className="large-icon">
          <Zap size={36} fill="currentColor" />
        </span>
        <span className="eyebrow">TAKE YOUR PLACE</span>
        <h1>
          Your buzzer.
          <br />
          <span className="gold">Your big moment.</span>
        </h1>
        <p className="muted">
          Find the six-digit code on your host’s screen.
          <br />
          We’ll save you a spot in the lobby.
        </p>
      </div>
      <div className="join-game-options">
        <PlayerGames />
        <form
          className="panel join-form"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            setHostConflict(false);
            try {
              const { data } = await supabase().auth.getSession();
              if (!data.session) {
                const result = await supabase().auth.signInAnonymously();
                if (result.error) throw result.error;
              }
              const result = await api<{ id: string }>('join', 'POST', { code, name });
              router.push(`/play/${result.id}`);
            } catch (e) {
              if (isHostPlayerConflict(e)) {
                setHostConflict(true);
                setError(
                  'This browser is signed in as the game host. Switch to a separate player identity to join. Your other device will stay signed in.',
                );
              } else {
                setError((e as Error).message);
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            GAME CODE
            <input
              className="code-input"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              autoComplete="off"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              required
            />
          </label>
          <label>
            Your name
            <input
              autoComplete="nickname"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={24}
              required
              placeholder="What should we call you?"
            />
          </label>
          <p className="error" role="alert">
            {error}
          </p>
          {hostConflict && (
            <button
              type="button"
              className="button primary full"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  const signedOut = await supabase().auth.signOut({ scope: 'local' });
                  if (signedOut.error) throw signedOut.error;
                  const guest = await supabase().auth.signInAnonymously();
                  if (guest.error) throw guest.error;
                  const result = await api<{ id: string }>('join', 'POST', { code, name });
                  router.push(`/play/${result.id}`);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Continue as Player
              <ArrowRight size={18} />
            </button>
          )}
          <button className="button primary full" disabled={busy}>
            {busy ? 'Finding your seat…' : 'Join the game'}
            <ArrowRight size={18} />
          </button>
          <p className="form-footnote">
            <Users size={15} /> No account needed. Just a little confidence.
          </p>
        </form>
        <RecoveryJoin initialCode={code} />
      </div>
    </div>
  );
}
