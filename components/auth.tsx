'use client';
import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { configured, supabase } from '@/lib/client';
import { hostConfirmationRedirect } from '@/lib/auth-flow';

export function SetupNotice() {
  return (
    <div className="panel narrow">
      <span className="eyebrow">ONE-TIME SETUP</span>
      <h1>Connect your game room.</h1>
      <p>
        Add the Supabase environment variables and apply the database migration to start hosting.
        The README walks through each step.
      </p>
      <p className="muted">
        Required: Supabase URL, public anon key, server service-role key, and rate-limit secret.
      </p>
    </div>
  );
}

export function HostAuth({ children }: { children: (user: User) => React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const [returnedFromConfirmation, setReturnedFromConfirmation] = useState(false);

  useEffect(() => {
    if (!configured()) {
      setLoading(false);
      return;
    }
    setReturnedFromConfirmation(new URLSearchParams(window.location.search).has('confirmed'));
    const client = supabase();
    client.auth.getUser().then(({ data }) => {
      setUser(data.user);
      setLoading(false);
    });
    const { data } = client.auth.onAuthStateChange((_event, session) =>
      setUser(session?.user ?? null),
    );
    return () => data.subscription.unsubscribe();
  }, []);

  if (!configured()) return <SetupNotice />;
  if (loading) return <div className="loading">Opening the host’s room…</div>;
  if (user && !user.is_anonymous)
    return (
      <>
        <div className="account-row">
          <span>{user.email}</span>
          <button
            className="text-button"
            onClick={() => void supabase().auth.signOut({ scope: 'local' })}
          >
            Sign out
          </button>
        </div>
        {children(user)}
      </>
    );

  return (
    <div className="panel narrow auth-panel">
      <span className="eyebrow">THE HOST’S ROOM</span>
      {pendingEmail ? (
        <>
          <h1>Check your inbox.</h1>
          <p role="status">
            We sent a confirmation link to <strong>{pendingEmail}</strong>. Open the link to verify
            your email, then come back and sign in to host.
          </p>
          <p className="muted">
            If you don't see it, check your spam folder. You don't need a Vercel account.
          </p>
          <button
            className="button primary full"
            onClick={() => {
              setPendingEmail('');
              setMode('login');
              setError('');
            }}
          >
            Back to sign in
          </button>
        </>
      ) : (
        <>
          <h1>{mode === 'login' ? 'Welcome back.' : 'Make game night yours.'}</h1>
          <p className="muted">Sign in to save your boards and resume games from any device.</p>
          {returnedFromConfirmation && (
            <p role="status" className="auth-notice">
              Returning from your email link? Once your address is verified, sign in below.
            </p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                if (user?.is_anonymous) {
                  const signedOut = await supabase().auth.signOut({ scope: 'local' });
                  if (signedOut.error) throw signedOut.error;
                }
                const result =
                  mode === 'login'
                    ? await supabase().auth.signInWithPassword({ email, password })
                    : await supabase().auth.signUp({
                        email,
                        password,
                        options: {
                          emailRedirectTo: hostConfirmationRedirect(
                            window.location.origin,
                            process.env.NEXT_PUBLIC_SITE_URL,
                          ),
                        },
                      });
                if (result.error) throw result.error;
                if (mode === 'signup') {
                  setPassword('');
                  if (!result.data.session) setPendingEmail(email);
                }
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Email
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                maxLength={128}
              />
            </label>
            <button className="button primary full" disabled={busy}>
              {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <p role="alert" className="error">
            {error}
          </p>
          <button
            className="text-button"
            onClick={() => {
              setMode(mode === 'login' ? 'signup' : 'login');
              setError('');
            }}
          >
            {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Sign in'}
          </button>
        </>
      )}
    </div>
  );
}
