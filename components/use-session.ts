'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, configured, supabase } from '@/lib/client';
import type { SessionView } from '@/lib/game/types';
import { takeLaunchController } from '@/lib/launch-controller';
import type { Command } from '@/lib/game/schema';
export function useSession(id: string, role: 'host' | 'player' | 'audience') {
  const [state, setState] = useState<SessionView>();
  const stateRef = useRef<SessionView | undefined>(undefined);
  const [userId, setUserId] = useState('');
  const [controller, setController] = useState('');
  const initialController = useRef<{ id: string; value: string } | undefined>(undefined);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const requestSequence = useRef(0);
  const latestConnectionResult = useRef(0);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const offset = useRef(0);
  const failSync = useCallback((failure: unknown, sequence: number) => {
    if (sequence < latestConnectionResult.current) return;
    latestConnectionResult.current = sequence;
    setConnected(false);
    setSyncError(
      failure instanceof Error ? failure.message : 'Could not fetch the game. Reconnecting…',
    );
  }, []);
  const accept = useCallback((next: SessionView, sequence: number) => {
    if (!stateRef.current || next.version >= stateRef.current.version) {
      stateRef.current = next;
      offset.current = next.serverNow - Date.now();
      setState(next);
    }
    if (sequence >= latestConnectionResult.current) {
      latestConnectionResult.current = sequence;
      setConnected(true);
      setSyncError('');
    }
  }, []);
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current;
    try {
      const next = await api<SessionView>(
        `sessions/${id}${role === 'audience' ? '?view=audience' : ''}`,
        'GET',
        undefined,
        controller || undefined,
      );
      accept(next, sequence);
    } catch (e) {
      failSync(e, sequence);
    }
  }, [id, role, controller, accept, failSync]);
  useEffect(() => {
    if (role !== 'host') return;
    if (initialController.current?.id !== id) {
      initialController.current = { id, value: takeLaunchController(id) ?? crypto.randomUUID() };
    }
    setController(initialController.current.value);
  }, [role, id]);
  useEffect(() => {
    if (!configured() || (role === 'host' && !controller)) return;
    let dead = false;
    const client = supabase();
    client.auth.getUser().then(({ data, error }) => {
      if (dead) return;
      if (error || !data.user) {
        setSyncError('Sign in or join the game again in this browser.');
        return;
      }
      setUserId(data.user.id);
      void refresh();
    });
    return () => {
      dead = true;
    };
  }, [refresh, role, controller]);
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

    return () => {
      alive = false;
      void client.removeChannel(channel);
    };
  }, [id, userId, refresh, role, !!state?.controllerOwned, !!state]);
  useEffect(() => {
    if (!userId) return;
    const timer = setInterval(() => void refresh(), 3000);
    const focus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('online', focus);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', focus);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [userId, refresh]);
  const send = useCallback(
    async (command: Command, quiet = false) => {
      const current = stateRef.current;
      if (!current) return false;
      if (!quiet) {
        setBusy(true);
        setError('');
      }
      const sequence = ++requestSequence.current;
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
        accept(next, sequence);
        return true;
      } catch (e) {
        const gameplayError =
          e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401;
        if (gameplayError) {
          if (!quiet) setError(e.message);
        } else failSync(e, sequence);
        await refresh();
        return false;
      } finally {
        if (!quiet) setBusy(false);
      }
    },
    [id, controller, accept, refresh, failSync],
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
  const answerRemaining =
    state?.answerDeadline !== undefined
      ? Math.max(0, state.answerDeadline - now)
      : state?.answerRemaining;
  useEffect(() => {
    if (
      state?.answerDeadline !== undefined &&
      answerRemaining !== undefined &&
      answerRemaining <= 0
    )
      void refresh();
  }, [answerRemaining !== undefined && answerRemaining <= 0, state?.answerDeadline, refresh]);
  useEffect(() => {
    if (state?.deadline !== undefined && remaining <= 0) void refresh();
  }, [remaining <= 0, state?.deadline, refresh]);
  return {
    state,
    userId,
    controller,
    error: error || syncError,
    setError,
    connected,
    busy,
    send,
    refresh,
    remaining,
    answerRemaining,
    now,
  };
}
