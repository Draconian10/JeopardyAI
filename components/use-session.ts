'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, configured, supabase } from '@/lib/client';
import type { SessionView } from '@/lib/game/types';
import type { Command } from '@/lib/game/schema';
export function useSession(id: string, role: 'host' | 'player' | 'audience') {
  const [state, setState] = useState<SessionView>();
  const stateRef = useRef<SessionView | undefined>(undefined);
  const [userId, setUserId] = useState('');
  const [controller, setController] = useState('');
  const [error, setError] = useState('');
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const offset = useRef(0);
  const accept = useCallback((next: SessionView) => {
    if (!stateRef.current || next.version >= stateRef.current.version) {
      stateRef.current = next;
      offset.current = next.serverNow - Date.now();
      setState(next);
    }
    setConnected(true);
  }, []);
  const refresh = useCallback(async () => {
    try {
      const next = await api<SessionView>(
        `sessions/${id}${role === 'audience' ? '?view=audience' : ''}`,
        'GET',
        undefined,
        controller || undefined,
      );
      accept(next);
    } catch (e) {
      setConnected(false);
      setError((e as Error).message);
    }
  }, [id, role, controller, accept]);
  useEffect(() => {
    if (role === 'host') setController(crypto.randomUUID());
  }, [role]);
  useEffect(() => {
    if (!configured()) return;
    let dead = false;
    const client = supabase();
    client.auth.getUser().then(({ data, error }) => {
      if (dead) return;
      if (error || !data.user) {
        setError('Sign in or join the game again in this browser.');
        return;
      }
      setUserId(data.user.id);
      void refresh();
    });
    return () => {
      dead = true;
    };
  }, [refresh]);
  useEffect(() => {
    if (!userId || !stateRef.current || (role === 'host' && !stateRef.current.controllerOwned))
      return;
    const client = supabase();
    let alive = true;
    const channel = client
      .channel(`session:${id}`, { config: { private: true } })
      .on('broadcast', { event: 'changed' }, () => {
        if (alive) void refresh();
      })
      .subscribe();

    const focus = () => {
      void refresh();
    };
    window.addEventListener('online', focus);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      alive = false;
      window.removeEventListener('online', focus);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
      void client.removeChannel(channel);
    };
  }, [id, userId, refresh, role, !!state?.controllerOwned, !!state]);
  useEffect(() => {
    if (!userId) return;
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [userId, refresh]);
  const send = useCallback(
    async (command: Command, quiet = false) => {
      const current = stateRef.current;
      if (!current) return false;
      if (!quiet) {
        setBusy(true);
        setError('');
      }
      try {
        const next = await api<SessionView>(
          `sessions/${id}/command`,
          'POST',
          {
            command,
            controller: controller || undefined,
            version: current.actionVersion,
            actionId: crypto.randomUUID(),
          },
          controller || undefined,
        );
        accept(next);
        return true;
      } catch (e) {
        if (!quiet) setError((e as Error).message);
        await refresh();
        return false;
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [id, controller, accept, refresh],
  );
  useEffect(() => {
    if (!state || role === 'audience' || !userId) return;
    const timer = setInterval(() => {
      const current = stateRef.current;
      if (!current || ['ended', 'finished'].includes(current.phase)) return;
      if (role === 'host' && !current.controllerOwned) return;
      void send({ type: 'heartbeat' }, true);
    }, 5000);
    return () => clearInterval(timer);
  }, [!!state, userId, role, send]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() + offset.current), 100);
    return () => clearInterval(timer);
  }, []);
  const remaining =
    state?.deadline !== undefined ? Math.max(0, state.deadline - now) : (state?.remaining ?? 0);
  useEffect(() => {
    if (state?.deadline !== undefined && remaining <= 0) void refresh();
  }, [remaining <= 0, state?.deadline, refresh]);
  return {
    state,
    userId,
    controller,
    error,
    setError,
    connected,
    busy,
    send,
    refresh,
    remaining,
    now,
  };
}
