'use client';
import { useState } from 'react';
import { api } from '@/lib/client';

export default function DisplayAccess({ sessionId }: { sessionId: string }) {
  const [url, setUrl] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  return (
    <div className="display-access">
      <button
        type="button"
        className="button secondary full"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const result = await api<{ token: string; expiresAt: string }>(
              `sessions/${sessionId}/display-link`,
              'POST',
            );
            const link = new URL(`/display/${sessionId}`, window.location.origin);
            link.searchParams.set('token', result.token);
            setUrl(link.toString());
            setExpiresAt(result.expiresAt);
            setCopied(false);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy
          ? 'Preparing display…'
          : url
            ? 'Replace audience link'
            : 'Create audience display link'}
      </button>
      {url && (
        <>
          <div className="button-row">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="button primary small-button"
            >
              Open display
            </a>
            <button
              type="button"
              className="button secondary small-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                  setCopied(true);
                } catch {
                  setError('Could not copy. Open the link and share it from the address bar.');
                }
              }}
            >
              {copied ? 'Copied' : 'Copy private link'}
            </button>
          </div>
          <p className="muted small">
            Read-only link; works on a TV or projector without logging in. Expires{' '}
            {new Date(expiresAt).toLocaleString()}. Replacing it revokes the old link. Do not share
            it publicly.
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </div>
  );
}
