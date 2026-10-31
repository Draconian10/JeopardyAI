'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  Plus,
  Play,
  LayoutGrid,
  Users,
  Pencil,
  Copy,
  Archive,
  Trophy,
} from 'lucide-react';
import { api } from '@/lib/client';
import { handoffController } from '@/lib/launch-controller';
import { HostAuth } from './auth';
import type { Board } from '@/lib/game/schema';
interface DashboardData {
  games: { id: string; title: string; version: number; updatedAt: string; archived: boolean }[];
  sessions: {
    id: string;
    gameId: string;
    joinCode: string;
    active: boolean;
    phase: string;
    players: number;
    createdAt: string;
  }[];
}
export default function Dashboard() {
  return <HostAuth>{() => <DashboardInner />}</HostAuth>;
}
function DashboardInner() {
  const [data, setData] = useState<DashboardData>();
  const [error, setError] = useState('');
  const [starting, setStarting] = useState<string>();
  const [pin, setPin] = useState('');
  const [separate, setSeparate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState('');
  const [launchController] = useState(() => crypto.randomUUID());
  const [ending, setEnding] = useState<string>();
  const router = useRouter();
  const refresh = useCallback(() => {
    api<DashboardData>('games')
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  useEffect(refresh, [refresh]);
  const [showArchived, setShowArchived] = useState(false);
  return (
    <div className="container">
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR GAME NIGHT HQ</span>
          <h1>
            The host’s room<span className="gold">.</span>
          </h1>
          <p className="muted">
            A fresh board or an unfinished rivalry. Pick up wherever you left off.
          </p>
        </div>
        <Link className="button primary" href="/host/edit/new">
          <Plus size={18} /> Create new game
        </Link>
      </div>
      <p role="alert" className="error">
        {error}
      </p>
      {!data ? (
        <div className="loading">Loading your boards…</div>
      ) : (
        <>
          <div className="section-line">
            <h2>
              <LayoutGrid size={20} /> Your boards{' '}
              <span className="count">
                {data.games.filter((g) => g.archived === showArchived).length}
              </span>
            </h2>
            <button className="text-button" onClick={() => setShowArchived(!showArchived)}>
              {showArchived ? 'Show active boards' : 'Archived boards'}
            </button>
          </div>
          {!data.games.filter((g) => g.archived === showArchived).length ? (
            <div className="empty-state">
              <LayoutGrid size={40} />
              <h2>Your next great game starts here.</h2>
              <p>Create a custom board, or load the starter questions in the editor.</p>
              <Link className="button primary" href="/host/edit/new">
                Create your first game <ArrowRight size={18} />
              </Link>
            </div>
          ) : (
            <div className="games-grid">
              {data.games
                .filter((g) => g.archived === showArchived)
                .map((game, i) => {
                  const active = data.sessions.filter((s) => s.gameId === game.id && s.active);
                  return (
                    <article className="game-card" key={game.id}>
                      <div className={`board-thumbnail tone-${i % 3}`} aria-hidden="true">
                        {Array.from({ length: 18 }, (_, i) => (
                          <i key={i}>${((i % 5) + 1) * 200}</i>
                        ))}
                      </div>
                      <div className="game-card-body">
                        <div className="card-topline">
                          <span className={`badge ${active.length ? 'green' : ''}`}>
                            {active.length ? 'IN PROGRESS' : 'SAVED BOARD'}
                          </span>
                          <span className="muted small">
                            {new Date(game.updatedAt).toLocaleDateString()}
                          </span>
                        </div>
                        <h2>{game.title}</h2>
                        {active.map((s) => (
                          <div className="resume-row" key={s.id}>
                            <div>
                              <b>Code {s.joinCode}</b>
                              <small>
                                {s.players} players · {new Date(s.createdAt).toLocaleString()}
                              </small>
                            </div>
                            <div className="session-actions">
                              <Link
                                className="button small-button primary"
                                href={`/host/session/${s.id}`}
                              >
                                Resume <Play size={13} />
                              </Link>
                              <button
                                type="button"
                                className="button small-button danger"
                                disabled={!!ending}
                                aria-label={`End session ${s.joinCode}`}
                                onClick={async () => {
                                  if (
                                    !window.confirm(
                                      `End session ${s.joinCode} permanently? Scores and history will be saved, but this session cannot be resumed.`,
                                    )
                                  )
                                    return;
                                  setEnding(s.id);
                                  setError('');
                                  try {
                                    await api(`sessions/${s.id}/end`, 'POST', {
                                      actionId: crypto.randomUUID(),
                                      confirmed: true,
                                    });
                                    refresh();
                                  } catch (error) {
                                    setError((error as Error).message);
                                  } finally {
                                    setEnding(undefined);
                                  }
                                }}
                              >
                                {ending === s.id ? 'Ending…' : 'End session'}
                              </button>
                            </div>
                          </div>
                        ))}
                        <div className="card-actions">
                          {!game.archived && (
                            <button
                              className="button secondary"
                              onClick={() => {
                                setStarting(game.id);
                                setPin('');
                                setSeparate(false);
                                setRequestId(crypto.randomUUID());
                                setError('');
                              }}
                            >
                              <Play size={16} />
                              {active.length ? 'New session' : 'Start game'}
                            </button>
                          )}
                          <Link
                            className="icon-button"
                            title="Edit board"
                            aria-label={`Edit ${game.title}`}
                            href={`/host/edit/${game.id}`}
                          >
                            <Pencil size={17} />
                          </Link>
                          <button
                            className="icon-button"
                            title="Duplicate board"
                            aria-label={`Duplicate ${game.title}`}
                            onClick={async () => {
                              try {
                                const pin = window.prompt('Set a six-digit host PIN for the copy:');
                                if (!pin) return;
                                const source = await api<{ board: Board }>(`games/${game.id}`);
                                const result = await api<{ id: string }>('games', 'POST', {
                                  board: {
                                    ...source.board,
                                    title: `${source.board.title.slice(0, 90)} (copy)`,
                                  },
                                  pin,
                                });
                                router.push(`/host/edit/${result.id}`);
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            <Copy size={17} />
                          </button>
                          <button
                            className="icon-button"
                            title={game.archived ? 'Restore' : 'Archive'}
                            aria-label={game.archived ? 'Restore board' : 'Archive board'}
                            onClick={async () => {
                              try {
                                await api(`games/${game.id}/archive`, 'POST', {
                                  archived: !game.archived,
                                  version: game.version,
                                });
                                refresh();
                              } catch (e) {
                                setError((e as Error).message);
                              }
                            }}
                          >
                            <Archive size={17} />
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
            </div>
          )}
          <div className="section-line history-heading">
            <h2>
              <Trophy size={20} /> Previous games
            </h2>
          </div>
          {data.sessions.filter((s) => !s.active).length ? (
            <div className="history-list">
              {data.sessions
                .filter((s) => !s.active)
                .map((s) => (
                  <Link key={s.id} href={`/host/session/${s.id}`}>
                    <span>
                      <b>{data.games.find((g) => g.id === s.gameId)?.title ?? 'Game'}</b>
                      <small>{new Date(s.createdAt).toLocaleString()}</small>
                    </span>
                    <span>
                      <Users size={15} /> {s.players} players ·{' '}
                      {s.phase === 'finished' ? 'Completed' : 'Ended'} <ArrowRight size={17} />
                    </span>
                  </Link>
                ))}
            </div>
          ) : (
            <p className="muted">The stories—and scores—will collect here.</p>
          )}
        </>
      )}
      {starting && (
        <div className="modal-backdrop">
          <section
            className="panel modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="start-title"
          >
            <h2 id="start-title">Let’s get everyone together.</h2>
            <p>Enter the host PIN. Players will get a different join code.</p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const result = await api<{ id: string }>(`games/${starting}/start`, 'POST', {
                    pin,
                    separate,
                    requestId,
                    controller: launchController,
                  });
                  handoffController(result.id, launchController);
                  router.push(`/host/session/${result.id}`);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label>
                Host PIN
                <input
                  autoFocus
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  type="password"
                  maxLength={6}
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                  required
                />
              </label>
              {data?.sessions.some((s) => s.gameId === starting && s.active) && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={separate}
                    onChange={(e) => setSeparate(e.target.checked)}
                    required
                  />
                  Start a separate session and keep the existing game.
                </label>
              )}
              <p className="error" role="alert">
                {error}
              </p>
              <div className="button-row">
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => setStarting(undefined)}
                >
                  Cancel
                </button>
                <button className="button primary" disabled={busy}>
                  {busy ? 'Creating…' : 'Open lobby'}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}
