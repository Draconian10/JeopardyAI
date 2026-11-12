'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, supabase } from '@/lib/client';

export default function RecoveryJoin({ initialCode }: { initialCode: string }) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState(initialCode);
  const [recoveryCode, setRecoveryCode] = useState('');
  const [requestId, setRequestId] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  useEffect(() => {
    if (initialCode) setCode(initialCode);
  }, [initialCode]);
  useEffect(() => {
    if (!requestId) return;
    let active = true;
    let inFlight = false;
    const check = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await api<{ status: string; sessionId?: string }>(
          `recovery/${requestId}`,
        );
        if (!active) return;
        setStatus(result.status);
        if (result.status === 'approved' && result.sessionId)
          router.replace(`/play/${result.sessionId}`);
      } catch {
        if (active) setError('Could not check the approval status. Keep this page open.');
      } finally {
        inFlight = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [requestId, router]);

  return (
    <section className="panel recovery-panel">
      <button type="button" className="text-button" onClick={() => setOpen(!open)}>
        {open ? 'Hide player recovery' : 'Lost your place? Recover your player seat'}
      </button>
      {open && (
        <>
          <p className="muted small">
            Enter your game code and the private recovery code you saved earlier. Your host
            must approve the transfer before your score and responses return.
          </p>
          {requestId ? (
            <p role="status">
              {status === 'approved'
                ? 'Approved. Reconnecting to your game…'
                : status === 'rejected' || status === 'expired'
                  ? 'Recovery was declined or expired. Request a new code from the host.'
                  : 'Waiting for the host to approve your recovery request.'}
            </p>
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError('');
                try {
                  const { data, error: sessionError } = await supabase().auth.getSession();
                  if (sessionError) throw sessionError;
                  if (data.session && !data.session.user.is_anonymous) {
                    const out = await supabase().auth.signOut({ scope: 'local' });
                    if (out.error) throw out.error;
                  }
                  const current = await supabase().auth.getSession();
                  if (!current.data.session) {
                    const guest = await supabase().auth.signInAnonymously();
                    if (guest.error) throw guest.error;
                  }
                  const result = await api<{ requestId: string }>('recovery/request', 'POST', {
                    code, recoveryCode: recoveryCode.trim(),
                  });
                  setRequestId(result.requestId);
                  setStatus('pending');
                  setRecoveryCode('');
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Six-digit game code
                <input
                  value={code}
                  pattern="[0-9]{6}"
                  maxLength={6}
                  inputMode="numeric"
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  required
                />
              </label>
              <label>
                Private recovery code
                <input
                  value={recoveryCode}
                  onChange={(e) => setRecoveryCode(e.target.value.trim())}
                  maxLength={24}
                  autoComplete="off"
                  required
                />
              </label>
              <button className="button primary full" disabled={busy}>
                {busy ? 'Requesting…' : 'Request host approval'}
              </button>
            </form>
          )}
          {error && <p className="error" role="alert">{error}</p>}
        </>
      )}
    </section>
  );
}
