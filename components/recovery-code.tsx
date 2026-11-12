'use client';
import { useState } from 'react';
import { api } from '@/lib/client';

export default function RecoveryCode({ sessionId }: { sessionId: string }) {
  const [code, setCode] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  return (
    <details className="panel recovery-panel player-recovery">
      <summary>Save a player recovery code</summary>
      <p className="muted small">
        If you lose access to this browser during the game, you can reclaim your score and Final
        response with this code and the host’s approval. Store it outside this device.
      </p>
      {code && (
        <>
          <p className="recovery-code" aria-label="Your recovery code">
            {code}
          </p>
          <p className="muted small">
            Valid until {new Date(expiresAt).toLocaleString()} or until your seat is recovered.
            Anyone with this code can request your seat; keep it private.
          </p>
        </>
      )}
      <div className="player-recovery-actions">
        {code && (
          <button
            type="button"
            className="button secondary small-button"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(code);
                setCopied(true);
              } catch {
                setError('Copy failed. Please record the code yourself.');
              }
            }}
          >
            {copied ? 'Copied' : 'Copy code'}
          </button>
        )}
        <button
          type="button"
          className="button secondary small-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              const result = await api<{ code: string; expiresAt: string }>(
                `sessions/${sessionId}/recovery-code`,
                'POST',
              );
              setCode(result.code);
              setExpiresAt(result.expiresAt);
              setCopied(false);
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Generating…' : code ? 'Replace recovery code' : 'Generate recovery code'}
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </details>
  );
}
