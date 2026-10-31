'use client';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { supabase } from '@/lib/client';
export default function DownloadResults({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div>
      <button
        type="button"
        className="button secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            const { data } = await supabase().auth.getSession();
            if (!data.session) throw new Error('Sign in again to download results.');
            const response = await fetch(`/api/sessions/${id}/results`, {
              headers: { Authorization: `Bearer ${data.session.access_token}` },
              cache: 'no-store',
            });
            if (!response.ok) {
              const body = await response.json();
              throw new Error(body.error ?? 'Could not download results. Please retry.');
            }
            const url = URL.createObjectURL(await response.blob());
            const link = document.createElement('a');
            link.href = url;
            link.download = `jeopardy-results-${id}.csv`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not download results. Please retry.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download size={17} />
        {busy ? 'Downloading…' : 'Download results (CSV)'}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
