'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/client';

type Request = { id: string; name: string; requestedAt: string };
export default function RecoveryRequests({
  sessionId,
  onApproved,
}: {
  sessionId: string;
  onApproved: () => Promise<void>;
}) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try {
      const result = await api<{ requests: Request[] }>(
        `sessions/${sessionId}/recovery-requests`,
      );
      setRequests(result.requests);
    } catch {
      setError('Could not check player recovery requests.');
    }
  }, [sessionId]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refresh]);
  if (!requests.length) return null;
  return (
    <section className="panel recovery-panel" aria-label="Player recovery requests">
      <h2>Player recovery requests</h2>
      <p className="muted small">
        Approve only after speaking with the player and verifying that this is their seat.
        Approval transfers their scores, wagers and saved responses to their new device.
      </p>
      {requests.map((request) => (
        <div className="recovery-request-row" key={request.id}>
          <div>
            <b>{request.name}</b>
            <p className="muted small">Requested {new Date(request.requestedAt).toLocaleTimeString()}</p>
          </div>
          <div className="button-row">
            <button
              className="button primary small-button"
              disabled={!!busy}
              onClick={async () => {
                if (!confirm(`Approve recovery for ${request.name}? Their previous device will lose access.`))
                  return;
                setBusy(request.id);
                setError('');
                try {
                  await api(`sessions/${sessionId}/recovery-approve`, 'POST', {
                    requestId: request.id,
                  });
                  await Promise.all([refresh(), onApproved()]);
                } catch (e) {
                  setError((e as Error).message);
                  void refresh();
                } finally {
                  setBusy('');
                }
              }}
            >
              Approve
            </button>
            <button
              className="button secondary small-button"
              disabled={!!busy}
              onClick={async () => {
                setBusy(request.id);
                setError('');
                try {
                  await api(`sessions/${sessionId}/recovery-reject`, 'POST', {
                    requestId: request.id,
                  });
                  await refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy('');
                }
              }}
            >
              Decline
            </button>
          </div>
        </div>
      ))}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
