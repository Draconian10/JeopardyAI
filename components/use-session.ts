'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, configured, supabase } from '@/lib/client';
import type { AnswerReceipt, HeartbeatReceipt, SessionView } from '@/lib/game/types';
import { takeLaunchController } from '@/lib/launch-controller';
import type { Command } from '@/lib/game/schema';
const stageKey = (s?: SessionView) =>
  JSON.stringify([s?.phase, s?.question?.id, s?.tiebreaker?.round?.id, s?.windowId]);
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
  const refreshInFlight = useRef<Promise<void> | undefined>(undefined);
  const refreshAgain = useRef(false);
  const latestSnapshotSequence = useRef(0);
  const realtimeHealthy = useRef(false);
  const heartbeatBusy = useRef(false);
  const failSync = useCallback((failure: unknown, sequence: number) => {
    if (sequence < latestConnectionResult.current) return;
    latestConnectionResult.current = sequence;
    setConnected(false);
    setSyncError(
      failure instanceof Error ? failure.message : 'Could not fetch the game. Reconnecting…',
    );
  }, []);
  const accept = useCallback((next: SessionView, sequence: number) => {
    const current = stateRef.current;
    const newer =
      !current ||
      next.version > current.version ||
      (next.version === current.version &&
        (next.runtimeAt !== undefined && current.runtimeAt !== undefined
          ? next.runtimeAt >= current.runtimeAt
          : sequence >= latestSnapshotSequence.current));
    if (newer) {
      if (stageKey(current) !== stageKey(next)) setError('');
      // An in-flight snapshot must not overwrite a newer acknowledged private draft.
      if (current && current.version === next.version) {
        for (const [id, entry] of Object.entries(current.finalEntries)) {
          if ((entry.revision ?? 0) > (next.finalEntries[id]?.revision ?? 0))
            next.finalEntries[id] = entry;
        }
      }
      latestSnapshotSequence.current = sequence;
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
  const refresh = useCallback((): Promise<void> => {
    if (refreshInFlight.current) {
      refreshAgain.current = true;
      return refreshInFlight.current;
    }
    const run = async () => {
      do {
        refreshAgain.current = false;
        const sequence = ++requestSequence.current;
        try {
          const next = await api<SessionView>(
            `sessions/${id}${role === 'audience' ? '?view=audience' : ''}`,
            'GET',
            undefined,
            controller || undefined,
            12000,
          );
          accept(next, sequence);
        } catch (e) {
          failSync(e, sequence);
        }
      } while (refreshAgain.current);
    };
    const pending = run().finally(() => {
      refreshInFlight.current = undefined;
    });
    refreshInFlight.current = pending;
    return pending;
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
      .on('broadcast', { event: 'changed' }, ({ payload }) => {
        if (!alive) return;
        if (
          typeof payload?.version === 'number' &&
          payload.version <= (stateRef.current?.version ?? -1)
        )
          return;
        void refresh();
      })
      .subscribe((status) => {
        if (!alive) return;
        realtimeHealthy.current = status === 'SUBSCRIBED';
        if (alive && realtimeHealthy.current) void refresh();
      });

    return () => {
      alive = false;
      realtimeHealthy.current = false;
      void client.removeChannel(channel);
    };
  }, [id, userId, refresh, role, !!state?.controllerOwned, !!state]);
  useEffect(() => {
    if (!userId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = () => {
      timer = setTimeout(
        async () => {
          await refresh();
          if (!stopped) poll();
        },
        (realtimeHealthy.current ? 10000 : 3000) + Math.random() * 300,
      );
    };
    poll();
    const focus = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('online', focus);
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener('online', focus);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [userId, refresh]);
  const send = useCallback(
    async (command: Command, quiet = false) => {
      const current = stateRef.current;
      if (!current) return false;
      if (command.type === 'heartbeat') {
        if (heartbeatBusy.current) return false;
        heartbeatBusy.current = true;
      }
      if (command.type === 'answer' && command.revision === undefined)
        command = { ...command, revision: (current.finalEntries[userId]?.revision ?? 0) + 1 };
      if (!quiet) {
        setBusy(true);
        setError('');
      }
      const sequence = ++requestSequence.current;
      const actionStage = stageKey(stateRef.current);
      try {
        const next = await api<SessionView | HeartbeatReceipt | AnswerReceipt>(
          `sessions/${id}/command`,
          'POST',
          {
            command,
            controller: controller || undefined,
            version: current.actionVersion,
            actionId: crypto.randomUUID(),
          },
          controller || undefined,
          command.type === 'heartbeat' ? 8000 : 15000,
        );
        if ('kind' in next) {
          offset.current = next.serverNow - Date.now();
          if (next.kind === 'heartbeat' && next.needsRefresh) void refresh();
          const current = stateRef.current;
          if (
            current &&
            next.kind === 'answer' &&
            (current.finalEntries[userId]?.revision ?? 0) <= next.revision
          ) {
            const patched = {
              ...current,
              finalEntries: {
                ...current.finalEntries,
                [userId]: {
                  ...current.finalEntries[userId],
                  text: next.text,
                  submittedAt: next.submittedAt,
                  revision: next.revision,
                },
              },
            };
            stateRef.current = patched;
            setState(patched);
          }
          if (sequence >= latestConnectionResult.current) {
            latestConnectionResult.current = sequence;
            setConnected(true);
            setSyncError('');
          }
        } else accept(next, sequence);
        return true;
      } catch (e) {
        const gameplayError =
          e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 401;
        if (gameplayError) {
          if (!quiet && actionStage === stageKey(stateRef.current)) setError(e.message);
        } else failSync(e, sequence);
        if (command.type !== 'heartbeat') await refresh();
        return false;
      } finally {
        if (command.type === 'heartbeat') heartbeatBusy.current = false;
        if (!quiet) setBusy(false);
      }
    },
    [id, controller, userId, accept, refresh, failSync],
  );
  useEffect(() => {
    if (!state || role === 'audience' || !userId) return;
    const renew = () => {
      const current = stateRef.current;
      if (!current || ['ended', 'finished'].includes(current.phase)) return;
      if (role === 'host' && !current.controllerOwned) return;
      void send({ type: 'heartbeat' }, true);
    };
    renew();
    const timer = setInterval(renew, 5000);
    const visible = () => {
      if (document.visibilityState === 'visible') renew();
    };
    window.addEventListener('online', visible);
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', visible);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
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
