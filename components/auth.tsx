'use client';
import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { configured, supabase } from '@/lib/client';
import { hostConfirmationRedirect, hostPasswordRecoveryRedirect } from '@/lib/auth-flow';

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

type AuthMode = 'login' | 'signup' | 'forgot' | 'reset';
export function HostAuth({ children }: { children: (user: User) => React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [mode, setMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingEmail, setPendingEmail] = useState('');
  const [resetSent, setResetSent] = useState(false);
  const [resetDone, setResetDone] = useState(false);
  const [returnedFromConfirmation, setReturnedFromConfirmation] = useState(false);
  const checkUser = useCallback(async () => {
    if (!configured()) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const { data, error } = await supabase().auth.getUser();
      if (error && error.name !== 'AuthSessionMissingError') throw error;
      setUser(data.user);
    } catch {
      setLoadError('Could not contact the sign-in service. Check your connection and retry.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!configured()) {
      setLoading(false);
      return;
    }
    const query = new URLSearchParams(window.location.search);
    setReturnedFromConfirmation(query.has('confirmed'));
    if (query.has('reset')) setMode('reset');
    void checkUser();
    const { data } = supabase().auth.onAuthStateChange((event, session) => {
      setUser(session?.user ?? null);
      if (event === 'PASSWORD_RECOVERY') setMode('reset');
    });
    return () => data.subscription.unsubscribe();
  }, [checkUser]);

  const confirmUrl = () =>
    hostConfirmationRedirect(window.location.origin, process.env.NEXT_PUBLIC_SITE_URL);
  const resetUrl = () =>
    hostPasswordRecoveryRedirect(window.location.origin, process.env.NEXT_PUBLIC_SITE_URL);

  if (!configured()) return <SetupNotice />;
  if (loading)
    return (
      <div className="panel narrow auth-panel">
        <p className="loading">Opening the host’s room…</p>
      </div>
    );
  if (loadError)
    return (
      <div className="panel narrow auth-panel">
        <h1>Unable to connect.</h1>
        <p role="alert" className="error">
          {loadError}
        </p>
        <button className="button primary full" onClick={() => void checkUser()}>
          Retry sign-in
        </button>
      </div>
    );
  if (user && !user.is_anonymous && mode !== 'reset')
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
            We sent a confirmation link to <strong>{pendingEmail}</strong>. Verify your address,
            then sign in to host.
          </p>
          <p className="muted">The link returns to Jeopardy. No Vercel account is needed.</p>
          <p role="alert" className="error">
            {error}
          </p>
          <button
            className="button secondary full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const result = await supabase().auth.resend({
                  type: 'signup',
                  email: pendingEmail,
                  options: { emailRedirectTo: confirmUrl() },
                });
                if (result.error) throw result.error;
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Sending…' : 'Resend confirmation email'}
          </button>
          <button
            className="button primary full"
            disabled={busy}
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
          <h1>
            {mode === 'login'
              ? 'Welcome back.'
              : mode === 'signup'
                ? 'Make game night yours.'
                : mode === 'forgot'
                  ? 'Reset your password.'
                  : 'Choose a new password.'}
          </h1>
          {mode === 'login' || mode === 'signup' ? (
            <p className="muted">Sign in to save your boards and resume games from any device.</p>
          ) : mode === 'forgot' ? (
            <p className="muted">We’ll email you a secure password-reset link.</p>
          ) : (
            <p className="muted">Set a new password to secure your host account.</p>
          )}
          {returnedFromConfirmation && mode === 'login' && (
            <p role="status" className="auth-notice">
              Returning from your email link? Once verified, sign in below.
            </p>
          )}
          {resetSent && mode === 'forgot' && (
            <p role="status" className="auth-notice">
              If an account exists for this address, we sent reset instructions. Check your inbox.
            </p>
          )}
          {resetDone && mode === 'login' && (
            <p role="status" className="auth-notice">
              Password updated. Sign in to continue.
            </p>
          )}
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              try {
                if (mode === 'reset') {
                  if (!user) throw new Error('This reset link has expired. Request a new link.');
                  if (password.length < 8) throw new Error('Use at least eight characters.');
                  if (password !== confirmPassword) throw new Error('Passwords do not match.');
                  const result = await supabase().auth.updateUser({ password });
                  if (result.error) throw result.error;
                  const out = await supabase().auth.signOut({ scope: 'local' });
                  if (out.error) throw out.error;
                  setUser(null);
                  setMode('login');
                  setResetDone(true);
                  setPassword('');
                  setConfirmPassword('');
                  window.history.replaceState(null, '', '/host');
                } else if (mode === 'forgot') {
                  const result = await supabase().auth.resetPasswordForEmail(email, {
                    redirectTo: resetUrl(),
                  });
                  if (result.error) throw result.error;
                  setResetSent(true);
                } else {
                  if (user?.is_anonymous) {
                    const out = await supabase().auth.signOut({ scope: 'local' });
                    if (out.error) throw out.error;
                  }
                  const result =
                    mode === 'login'
                      ? await supabase().auth.signInWithPassword({ email, password })
                      : await supabase().auth.signUp({
                          email,
                          password,
                          options: { emailRedirectTo: confirmUrl() },
                        });
                  if (result.error) throw result.error;
                  if (mode === 'signup') {
                    setPassword('');
                    if (!result.data.session) setPendingEmail(email);
                  }
                }
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {mode !== 'reset' && (
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
            )}
            {mode !== 'forgot' && (
              <label>
                {mode === 'reset' ? 'New password' : 'Password'}
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
            )}
            {mode === 'reset' && (
              <label>
                Confirm new password
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={8}
                  maxLength={128}
                />
              </label>
            )}
            <button className="button primary full" disabled={busy}>
              {busy
                ? 'Please wait…'
                : mode === 'login'
                  ? 'Sign in'
                  : mode === 'signup'
                    ? 'Create account'
                    : mode === 'forgot'
                      ? 'Send reset link'
                      : 'Update password'}
            </button>
          </form>
          <p role="alert" className="error">
            {error}
          </p>
          {mode === 'login' && (
            <div className="auth-link-row">
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setMode('signup');
                  setError('');
                }}
              >
                New here? Create an account
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setMode('forgot');
                  setError('');
                  setResetSent(false);
                }}
              >
                Forgot password?
              </button>
            </div>
          )}
          {mode === 'signup' && (
            <button
              className="text-button"
              onClick={() => {
                setMode('login');
                setError('');
              }}
            >
              Already have an account? Sign in
            </button>
          )}
          {mode === 'forgot' && (
            <button
              className="text-button"
              onClick={() => {
                setMode('login');
                setError('');
              }}
            >
              Back to sign in
            </button>
          )}
          {mode === 'reset' && !user && (
            <button
              className="text-button"
              onClick={() => {
                setMode('forgot');
                setError('');
              }}
            >
              Request a new reset link
            </button>
          )}
        </>
      )}
    </div>
  );
}
