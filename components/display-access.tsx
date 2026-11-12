'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Monitor, MoreHorizontal, RefreshCw } from 'lucide-react';
import { api } from '@/lib/client';

type StoredLink = { url: string; expiresAt: number };
type LinkResponse = { token: string; expiresAt: string };

function validStoredLink(link: StoredLink, sessionId: string): boolean {
  try {
    const url = new URL(link.url);
    return (
      url.origin === window.location.origin &&
      url.pathname === `/display/${sessionId}` &&
      /^[A-Za-z0-9_-]{32}$/.test(url.searchParams.get('token') ?? '') &&
      link.expiresAt > Date.now() + 60_000
    );
  } catch {
    return false;
  }
}

export default function DisplayAccess({
  sessionId,
  placement = 'sidebar',
}: {
  sessionId: string;
  placement?: 'sidebar' | 'lobby';
}) {
  const [busy, setBusy] = useState(false);
  const [hasLink, setHasLink] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const stored = useRef<StoredLink | null>(null);
  const pending = useRef<Promise<StoredLink> | null>(null);
  const menuRef = useRef<HTMLDetailsElement>(null);
  const storageKey = `jeopardy:audience-display:${sessionId}`;

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storageKey);
      const entry = raw ? (JSON.parse(raw) as StoredLink) : null;
      if (entry && validStoredLink(entry, sessionId)) {
        stored.current = entry;
        setHasLink(true);
      } else {
        sessionStorage.removeItem(storageKey);
        stored.current = null;
        setHasLink(false);
      }
    } catch {
      stored.current = null;
      setHasLink(false);
    }
  }, [sessionId, storageKey]);

  const getLink = useCallback(
    async (replace = false): Promise<StoredLink> => {
      if (!replace && stored.current && validStoredLink(stored.current, sessionId))
        return stored.current;
      if (pending.current) return pending.current;

      const request = (async () => {
        const { token, expiresAt } = await api<LinkResponse>(
          `sessions/${sessionId}/display-link`,
          'POST',
        );
        if (!/^[A-Za-z0-9_-]{32}$/.test(token))
          throw new Error('Could not create a valid audience display link.');
        const url = new URL(`/display/${sessionId}`, window.location.origin);
        url.searchParams.set('token', token);
        const entry = { url: url.toString(), expiresAt: Date.parse(expiresAt) };
        if (!validStoredLink(entry, sessionId))
          throw new Error('The audience display link has expired. Try again.');
        stored.current = entry;
        setHasLink(true);
        setCopied(false);
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(entry));
        } catch {
          // A private browser can disable session storage; the in-memory link still works.
        }
        return entry;
      })();
      pending.current = request;
      try {
        return await request;
      } finally {
        pending.current = null;
      }
    },
    [sessionId, storageKey],
  );

  const openDisplay = async () => {
    // Reserve the tab directly from the click so popup blockers do not reject the
    // asynchronous Supabase request. Reuse the same link; opening again must NOT
    // invalidate a projector that is already displaying the game.
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      setError('Allow popups to open the display, or use the link options to copy it.');
      return;
    }
    tab.opener = null;
    setBusy(true);
    setError('');
    try {
      const link = await getLink();
      tab.location.replace(link.url);
    } catch (cause) {
      tab.close();
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const copyDisplay = async () => {
    setBusy(true);
    setError('');
    try {
      const link = await getLink();
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      if (menuRef.current) menuRef.current.open = false;
    } catch (cause) {
      setError((cause as Error).message || 'Could not copy the display link.');
    } finally {
      setBusy(false);
    }
  };

  const replaceDisplay = async () => {
    if (
      !window.confirm(
        'Replace the audience link? The previous link will stop working on any open projector or TV.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await getLink(true);
      if (menuRef.current) menuRef.current.open = false;
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`display-access display-access--${placement}`}>
      <button
        type="button"
        className={placement === 'lobby' ? 'text-button' : 'button secondary full'}
        disabled={busy}
        onClick={() => void openDisplay()}
      >
        <Monitor size={16} />
        {busy
          ? 'Opening display…'
          : placement === 'lobby'
            ? 'Open audience display'
            : 'Audience display'}
      </button>
      <details className="display-options" ref={menuRef}>
        <summary aria-label="Audience display options" title="Audience display options">
          <MoreHorizontal size={18} aria-hidden="true" />
        </summary>
        <div className="display-options-menu">
          <button type="button" disabled={busy} onClick={() => void copyDisplay()}>
            <Copy size={14} aria-hidden="true" />
            {copied ? 'Copy link again' : 'Copy display link'}
          </button>
          {hasLink && (
            <button type="button" disabled={busy} onClick={() => void replaceDisplay()}>
              <RefreshCw size={14} aria-hidden="true" />
              Replace link
            </button>
          )}
        </div>
      </details>
      {error && (
        <p role="alert" className="display-access-error error">
          {error}
        </p>
      )}
      <span className="sr-only" role="status">
        {copied ? 'Audience display link copied.' : ''}
      </span>
    </div>
  );
}
