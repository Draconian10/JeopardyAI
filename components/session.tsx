'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  X,
  Pause,
  Play,
  Trophy,
  Zap,
  Users,
  Copy,
  Monitor,
  Lock,
  Unlock,
  RotateCcw,
  Volume2,
  VolumeX,
  Star,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { HostAuth, SetupNotice } from './auth';
import { configured, money } from '@/lib/client';
import { useSession } from './use-session';
import KeepAwake from './keep-awake';
import FinalSubmissions from './final-submissions';
import { finalSubmissionStatus } from '@/lib/game/final-submissions';
import Standings from './standings';
import DownloadResults from './download-results';
import ResultsConfetti from './results-confetti';
import Tiebreaker from './tiebreaker';
import ConnectionHealthPanel from './connection-health';
import RecoveryCode from './recovery-code';
import RecoveryRequests from './recovery-requests';
import DisplayAccess from './display-access';
import PracticeRound from './practice-round';
import DailyDoubleWager from './daily-double-wager';
import { PRACTICE_PHASES, TIE_PHASES } from '@/lib/game/engine';
import type { SessionView } from '@/lib/game/types';
export default function GameSession({
  id,
  role,
  displayToken,
}: {
  id: string;
  role: 'host' | 'player' | 'audience';
  displayToken?: string;
}) {
  if (role === 'host') return <HostAuth>{() => <SessionInner id={id} role={role} />}</HostAuth>;
  if (!configured()) return <SetupNotice />;
  return <SessionInner id={id} role={role} displayToken={displayToken} />;
}
function SessionInner({
  id,
  role,
  displayToken,
}: {
  id: string;
  role: 'host' | 'player' | 'audience';
  displayToken?: string;
}) {
  const {
    state: s,
    userId,
    controller,
    error,
    setError,
    connected,
    health,
    refresh,
    now,
    busy,
    send,
    remaining,
    answerRemaining,
  } = useSession(id, role, displayToken);
  const [pin, setPin] = useState('');
  const [wager, setWager] = useState('0');
  const [draft, setDraft] = useState('');
  const [draftStatus, setDraftStatus] = useState('');
  const [sound, setSound] = useState(false);
  const [origin, setOrigin] = useState('');
  const [copied, setCopied] = useState(false);
  const draftInitialized = useRef(false);
  const lastSaved = useRef('');
  const draftRef = useRef('');
  const saveInFlight = useRef(false);
  const host = role === 'host';
  const audience = role === 'audience';
  const player = role === 'player';
  const ended = s && ['finished', 'ended'].includes(s.phase);
  const control = host && s?.controllerOwned && !ended;
  const me = s?.players.find((p) => p.id === userId);
  useEffect(() => setOrigin(window.location.origin), []);
  useEffect(() => {
    if (s?.phase === 'finalAnswer' && !draftInitialized.current) {
      const text = s.finalEntries[userId]?.text ?? '';
      setDraft(text);
      draftRef.current = text;
      lastSaved.current = text;
      draftInitialized.current = true;
    }
  }, [s, userId]);
  useEffect(() => {
    if (!player || s?.phase !== 'finalAnswer' || s.paused || remaining <= 0) return;
    const timer = setInterval(async () => {
      if (saveInFlight.current || draftRef.current === lastSaved.current) return;
      saveInFlight.current = true;
      const text = draftRef.current;
      setDraftStatus('Saving…');
      const ok = await send({ type: 'answer', text }, true);
      if (ok) {
        lastSaved.current = text;
        setDraftStatus('Saved');
      } else setDraftStatus('Not saved — check your connection');
      saveInFlight.current = false;
    }, 500);
    return () => clearInterval(timer);
  }, [player, s?.phase, s?.paused, remaining <= 0, send]);
  const previousPhase = useRef(s?.phase);
  useEffect(() => {
    if (
      sound &&
      s &&
      previousPhase.current !== s.phase &&
      ['answering', 'question', 'reveal', 'tieQuestion', 'tieAnswer', 'tieReveal'].includes(s.phase)
    ) {
      try {
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.connect(gain);
        gain.connect(audio.destination);
        gain.gain.value = 0.08;
        oscillator.frequency.value = ['answering', 'tieAnswer'].includes(s.phase) ? 740 : 440;
        oscillator.start();
        oscillator.stop(audio.currentTime + 0.12);
        oscillator.onended = () => void audio.close();
      } catch {
        /* Sound is optional. */
      }
    }
    previousPhase.current = s?.phase;
  }, [s?.phase, sound]);
  const canBuzz =
    !!s &&
    player &&
    connected &&
    !busy &&
    !s.paused &&
    ['question', 'practiceOpen', 'tieQuestion'].includes(s.phase) &&
    (s.phase !== 'tieQuestion' || !!s.tiebreaker?.playerIds.includes(userId)) &&
    remaining > 0 &&
    !s.attempted.includes(userId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input,textarea,select,button')) return;
      if (player && e.code === 'Space' && canBuzz && s?.windowId) {
        e.preventDefault();
        void send({ type: 'buzz', windowId: s.windowId });
      }
      if (control && s && !s.paused && s.phase === 'answering') {
        if (e.key.toLowerCase() === 'c') void send({ type: 'judge', correct: true });
        if (e.key.toLowerCase() === 'x') void send({ type: 'judge', correct: false });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canBuzz, s, player, control, send]);
  if (!s)
    return (
      <div className="container">
        <p role="alert" className="error">
          {error}
        </p>
        <div className="loading">Connecting to the game…</div>
        <Link className="button secondary" href={host ? '/host' : '/join'}>
          Back to {host ? 'your boards' : 'join'}
        </Link>
      </div>
    );
  const answerClock = ['answering', 'tieAnswer'].includes(s.phase) && answerRemaining !== undefined;
  const seconds = Math.ceil((answerClock ? answerRemaining : remaining)! / 1000);
  const answering = s.players.find((p) => p.id === s.respondent);
  const daily = s.players.find((p) => p.id === s.daily?.playerId);
  const finalEntry = s.finalEntries[userId];
  const current = s.players.find((p) => p.id === s.finalReviewPlayer);
  const max = me ? Math.abs(finalEntry?.score ?? me.score) : 0;
  const joinUrl = `${origin}/join?code=${s.joinCode}`;
  const judgment = (type: 'judge' | 'dailyJudge', correct: boolean) => void send({ type, correct });
  const timer = (
    <div
      className={`timer ${seconds <= 5 && (s.deadline || s.answerDeadline) ? 'urgent' : ''}`}
      aria-label={`${seconds} seconds remaining`}
    >
      <span>
        {String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}
      </span>
      <small>
        {s.paused
          ? 'PAUSED'
          : answerClock
            ? 'RESPONSE DEADLINE'
            : s.phase === 'answering'
              ? 'TIMER PAUSED'
              : 'TIME REMAINING'}
      </small>
    </div>
  );
  const takeControl = (
    <form
      className="claim-form"
      onSubmit={(e) => {
        e.preventDefault();
        void send({ type: 'claim', pin, controller });
      }}
    >
      <label>
        Host PIN
        <input
          type="password"
          autoFocus
          inputMode="numeric"
          maxLength={6}
          pattern="[0-9]{6}"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
          required
        />
      </label>
      <button className="button primary" disabled={busy}>
        Resume / take control
      </button>
      <p className="muted small">
        This pauses the game and makes this tab the controller. Players, scores, and the join code
        stay the same.
      </p>
    </form>
  );
  const finishedContent = (
    <div className={`celebration panel ${s.phase === 'finished' ? 'final-celebration' : ''}`}>
      <Trophy className="winner-icon" size={64} />
      <span className="eyebrow">{s.phase === 'finished' ? 'FINAL RESULTS' : 'SESSION ENDED'}</span>
      <h1>
        {s.phase === 'finished'
          ? (() => {
              const high = Math.max(...s.players.map((p) => p.score));
              const winners = s.players.filter((p) =>
                s.tiebreaker?.winnerId ? p.id === s.tiebreaker.winnerId : p.score === high,
              );
              return `${winners.map((p) => p.name).join(' & ')} ${winners.length > 1 ? 'win!' : 'wins!'}`;
            })()
          : 'Thanks for playing.'}
      </h1>
      <p className="muted">
        {s.phase === 'finished'
          ? s.tiebreaker?.winnerId
            ? 'Decided by a sudden-death tiebreaker. Final scores stay unchanged.'
            : 'Final standings are confirmed. Congratulations!'
          : 'Your game history has been saved.'}
      </p>
      {s.finalAnswer && !s.tiebreaker?.winnerId && (
        <div className="answer-reveal">
          <small>FINAL JEOPARDY · CORRECT RESPONSE</small>
          <h2>{s.finalAnswer}</h2>
        </div>
      )}
      {s.tiebreaker?.winnerId && s.tiebreaker.round && (
        <div className="answer-reveal">
          <small>WINNING TIEBREAKER · {s.tiebreaker.round.category}</small>
          <h2>{s.tiebreaker.round.answer}</h2>
        </div>
      )}
      <Standings s={s} />
      <div className="results-actions">
        {host && <DownloadResults id={s.id} />}
        <Link className="button primary" href={host ? '/host' : '/'}>
          Back to {host ? 'your boards' : 'home'} <ArrowRight size={16} />
        </Link>
      </div>
    </div>
  );
  return (
    <div
      data-game-phase={s.phase}
      data-buzzer-window={s.windowId ?? ''}
      data-session-transport={health.transport}
      className={`container session-container ${player ? 'player-container' : ''} ${audience ? 'audience-container' : ''}`}
    >
      {s.phase === 'finished' && <ResultsConfetti sessionId={s.id} />}
      <div className="session-topline">
        <Link className="back-link" href={host ? '/host' : '/'}>
          <ArrowLeft size={15} />
          {host ? 'Your boards' : 'Home'}
        </Link>
        {!audience && !ended && <KeepAwake key={id} />}
        <div className="button-row session-connection-controls">
          <span className={`connection ${connected ? '' : 'offline'}`}>
            {connected ? <Wifi size={13} /> : <WifiOff size={13} />}{' '}
            {connected ? 'Connected' : 'Reconnecting'}
          </span>
          <button
            className="icon-button"
            aria-label={sound ? 'Mute sound' : 'Enable sound'}
            onClick={() => setSound(!sound)}
          >
            {sound ? <Volume2 size={17} /> : <VolumeX size={17} />}
          </button>
        </div>
      </div>
      {host && !audience && (
        <ConnectionHealthPanel s={s} health={health} now={now} refresh={refresh} />
      )}
      <div className="live-heading">
        <div>
          <span className="eyebrow">
            {host
              ? 'HOST CONSOLE'
              : audience
                ? 'GAME NIGHT LIVE'
                : s.phase === 'lobby'
                  ? 'YOU’RE IN'
                  : 'PLAYER CONSOLE'}
          </span>
          <h1>{player ? `Let’s go, ${me?.name ?? 'contender'}.` : s.title}</h1>
        </div>
        {!player && (
          <div className="code-pill">
            GAME CODE <b>{s.joinCode}</b>
          </div>
        )}
      </div>
      <p role="alert" className="error">
        {error}
      </p>
      {player && me && !ended && <RecoveryCode sessionId={id} />}
      {host && !ended && <RecoveryRequests sessionId={id} onApproved={refresh} />}
      {host && !control && !ended && (
        <div className="panel control-claim">
          <h2>Pick up where you left off.</h2>
          {takeControl}
        </div>
      )}
      {s.hostReconnecting && !s.paused && !ended && (
        <p className="timeout-notice" role="status">
          Reconnecting to host — your progress is saved.
        </p>
      )}
      {s.paused && !ended && (
        <div className="pause-banner">
          <Pause size={20} />
          <span>
            <b>
              {s.pauseReason === 'Host disconnected'
                ? 'Game paused while reconnecting to the host.'
                : 'Game paused.'}
            </b>{' '}
            Your place and scores are saved.
          </span>
          {control && (
            <button
              className="button primary small-button"
              disabled={busy}
              onClick={() => void send({ type: 'continue' })}
            >
              Continue game <Play size={14} />
            </button>
          )}
        </div>
      )}
      {ended ? (
        finishedContent
      ) : s.phase === 'lobby' ? (
        <div className={`lobby-layout ${player ? 'player-lobby' : ''}`}>
          <section className="panel lobby-invite">
            <span className="eyebrow">THE ROOM IS OPEN</span>
            <h2>{player ? 'You’ve got a seat.' : 'Bring your people.'}</h2>
            <p className="muted">
              {player
                ? 'Stay on this page. Your host will start the game when everyone is ready.'
                : 'Scan the code or join with the six digits below.'}
            </p>
            {!player && (
              <>
                <div className="qr-wrap">
                  <QRCodeSVG value={joinUrl} size={148} bgColor="#ffffff" fgColor="#15223d" />
                </div>
                <div className="lobby-code">{s.joinCode}</div>
                <button
                  className="text-button"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(joinUrl);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch {
                      setError('Could not copy. Share the game code instead.');
                    }
                  }}
                >
                  <Copy size={15} />
                  {copied ? 'Link copied' : 'Copy join link'}
                </button>
              </>
            )}
            {control && (
              <div className="lobby-controls">
                <label className="answer-limit-setting">
                  Response deadline after buzzing
                  <select
                    aria-label="Response deadline after buzzing"
                    value={s.answerLimitSeconds ?? 0}
                    disabled={busy || s.paused}
                    onChange={(e) =>
                      void send({ type: 'configure', answerLimitSeconds: Number(e.target.value) })
                    }
                  >
                    <option value={0}>Off — host judges without a deadline</option>
                    {[5, 10, 15, 20, 30, 45, 60].map((n) => (
                      <option key={n} value={n}>
                        {n} seconds
                      </option>
                    ))}
                  </select>
                </label>
                <p className="muted small">
                  After a regular buzz, an expired response deducts the clue value. In a tiebreaker,
                  it counts as a miss without changing scores. Daily Double and Final Jeopardy are
                  unchanged.
                </p>
                <button
                  className="button secondary full"
                  disabled={busy || s.paused || !s.players.length}
                  onClick={() => void send({ type: 'practiceStart' })}
                >
                  <Zap size={16} />
                  Start practice round
                </button>

                <button
                  className="button secondary full"
                  disabled={busy || s.paused}
                  onClick={() => void send({ type: 'lockLobby', locked: !s.locked })}
                >
                  {s.locked ? <Lock size={15} /> : <Unlock size={15} />}{' '}
                  {s.locked ? 'Unlock lobby' : 'Lock lobby'}
                </button>
                <button
                  className="button primary full"
                  disabled={busy || s.paused || !s.players.length}
                  onClick={() => void send({ type: 'start' })}
                >
                  Start Jeopardy <ArrowRight size={17} />
                </button>
              </div>
            )}
            {player && (
              <div className="waiting-dots">
                <i />
                <i />
                <i />
              </div>
            )}
          </section>
          <section className="panel lobby-players">
            <div className="section-line">
              <h2>
                <Users size={20} /> The contenders <span className="count">{s.players.length}</span>
              </h2>
            </div>
            {s.players.map((p, i) => (
              <div className="lobby-player" key={p.id}>
                <span className={`player-avatar avatar-${i % 4}`}>{p.name[0].toUpperCase()}</span>
                <span className="grow">
                  <b>
                    {p.name}
                    {p.id === userId ? ' (you)' : ''}
                  </b>
                  <small>
                    {s.serverNow - p.lastSeen < 15000 ? 'Ready to play' : 'Reconnecting'}
                  </small>
                </span>
                <span className={`live-dot ${s.serverNow - p.lastSeen < 15000 ? '' : 'away'}`} />
                {control && (
                  <button
                    className="icon-button"
                    disabled={busy || s.paused}
                    aria-label={`Remove ${p.name}`}
                    onClick={() => {
                      if (confirm(`Remove ${p.name} from this session?`))
                        void send({ type: 'remove', playerId: p.id });
                    }}
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            ))}
            {!s.players.length && (
              <div className="empty-players">
                <Users size={38} />
                <p>Waiting for your first contender…</p>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className={player ? 'player-game' : 'host-game-layout'}>
          <div className="game-main">
            {player && (
              <div className="personal-score panel">
                <span>YOUR SCORE</span>
                <strong>{money(me?.score ?? 0)}</strong>
                <small>
                  Rank{' '}
                  {[...s.players]
                    .sort((a, b) => b.score - a.score)
                    .findIndex((p) => p.id === userId) + 1}{' '}
                  of {s.players.length}
                </small>
              </div>
            )}
            {TIE_PHASES.includes(s.phase) && (
              <Tiebreaker
                s={s}
                player={player}
                host={host}
                userId={userId}
                control={!!control}
                busy={busy}
                canBuzz={canBuzz}
                timer={timer}
                send={send}
              />
            )}
            {PRACTICE_PHASES.includes(s.phase) && (
              <PracticeRound
                s={s}
                player={player}
                userId={userId}
                control={!!control}
                busy={busy}
                connected={connected}
                remaining={remaining}
                timer={timer}
                send={send}
              />
            )}
            {s.lastTimeout && (
              <p className="timeout-notice" role="status">
                Response time expired for{' '}
                {s.players.find((p) => p.id === s.lastTimeout?.playerId)?.name}. The clue value was
                deducted.{s.phase === 'question' ? ' Other eligible players can buzz now.' : ''}
              </p>
            )}
            {['board', 'question', 'answering', 'dailyWager', 'dailyAnswer', 'reveal'].includes(
              s.phase,
            ) &&
              s.nextSelectorId && (
                <div className="selection-indicator panel" role="status" aria-live="polite">
                  <strong>
                    Next selection: {s.players.find((p) => p.id === s.nextSelectorId)?.name}
                  </strong>
                  <span>
                    {player && s.nextSelectorId === userId
                      ? 'Your choice — tell the host the category and value.'
                      : 'The host selects the tile on the board.'}
                  </span>
                </div>
              )}
            {s.phase === 'board' &&
              (player ? (
                <div className="panel player-wait">
                  <Zap size={38} />
                  <h2>Ready when you are.</h2>
                  <p className="muted">Tell the host which clue to select when it is your turn.</p>
                </div>
              ) : (
                <div className="board-scroll">
                  <div
                    className="jeopardy-board"
                    style={{
                      gridTemplateColumns: `repeat(${s.categories.length}, minmax(102px,1fr))`,
                    }}
                  >
                    {s.categories.map((c, i) => (
                      <div className="category" key={i}>
                        {c}
                      </div>
                    ))}
                    {Array.from({ length: s.rows }, (_, row) =>
                      s.categories.map((_, category) => {
                        const tile = s.tiles.find((t) => t.row === row && t.category === category)!;
                        return (
                          <button
                            key={tile.id}
                            data-clue-id={tile.id}
                            className={`board-tile ${tile.used ? 'used' : ''}`}
                            disabled={!control || busy || s.paused || tile.used}
                            onClick={() => void send({ type: 'select', questionId: tile.id })}
                          >
                            {tile.used ? <Check size={23} /> : money(tile.value)}
                          </button>
                        );
                      }),
                    )}
                  </div>
                </div>
              ))}
            {['question', 'answering'].includes(s.phase) &&
              (player ? (
                <section className="buzzer-section">
                  {timer}
                  <button
                    className={`buzzer ${canBuzz ? 'ready' : ''} ${s.respondent === userId ? 'won' : ''}`}
                    disabled={!canBuzz}
                    onClick={() => {
                      if (s.windowId) {
                        if (navigator.vibrate) navigator.vibrate(45);
                        void send({ type: 'buzz', windowId: s.windowId });
                      }
                    }}
                  >
                    <Zap size={48} fill="currentColor" />
                    <b>
                      {busy
                        ? 'CHECKING…'
                        : s.respondent === userId && s.phase === 'answering'
                          ? 'YOU’RE UP!'
                          : canBuzz
                            ? 'BUZZ!'
                            : 'HOLD TIGHT'}
                    </b>
                  </button>
                  <p className="buzzer-status" role="status">
                    {s.paused
                      ? 'Waiting for the game to resume'
                      : s.phase === 'answering'
                        ? s.respondent === userId
                          ? 'Give your response to the host.'
                          : `${answering?.name} is answering`
                        : s.attempted.includes(userId)
                          ? 'You’ve already attempted this clue'
                          : remaining <= 0
                            ? 'Time’s up'
                            : 'Know it? Make your move.'}
                  </p>
                  <small className="muted">
                    {s.question?.category} · {money(s.question?.value ?? 0)}
                  </small>
                </section>
              ) : (
                <section className="question-stage">
                  <div className="question-top">
                    <span className="eyebrow">
                      {s.question?.category} · {money(s.question?.value ?? 0)}
                    </span>
                    {timer}
                  </div>
                  <h2 className={s.phase === 'answering' ? 'clue-hidden' : undefined}>
                    {s.phase === 'answering'
                      ? `Clue hidden while ${answering?.name} answers`
                      : s.question?.prompt}
                  </h2>
                  {s.phase === 'answering' ? (
                    <div className="respondent">
                      <span className="player-avatar">{answering?.name[0]}</span>
                      <b>{answering?.name} is answering</b>
                      {control && (
                        <div className="button-row">
                          <button
                            className="button success"
                            disabled={busy || s.paused}
                            onClick={() => judgment('judge', true)}
                          >
                            <Check size={18} /> Correct
                          </button>
                          <button
                            className="button danger"
                            disabled={busy || s.paused}
                            onClick={() => judgment('judge', false)}
                          >
                            <X size={18} /> Incorrect
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="buzz-open">
                      <span className="live-dot" />{' '}
                      {remaining > 0 ? 'BUZZERS ARE OPEN' : 'TIME’S UP'}
                    </p>
                  )}
                  {host && (
                    <details className="host-answer">
                      <summary>Private correct response</summary>
                      <p>{s.question?.answer}</p>
                      <small>{s.question?.notes}</small>
                    </details>
                  )}
                </section>
              ))}
            {s.phase === 'dailyWager' && (
              <DailyDoubleWager
                key={s.question?.id}
                s={s}
                player={player}
                userId={userId}
                control={!!control}
                busy={busy}
                connected={connected}
                send={send}
              />
            )}
            {s.phase === 'dailyAnswer' && (
              <section className="question-stage daily-stage">
                <span className="eyebrow">
                  DAILY DOUBLE · {daily?.name} · {money(s.daily?.amount ?? 0)}
                </span>
                <h2>{s.question?.prompt}</h2>
                <p className="muted">Buzzers disabled. {daily?.name} answers aloud.</p>
                {control && (
                  <div className="button-row centered">
                    <button
                      className="button success"
                      disabled={busy || s.paused}
                      onClick={() => judgment('dailyJudge', true)}
                    >
                      <Check size={18} /> Correct
                    </button>
                    <button
                      className="button danger"
                      disabled={busy || s.paused}
                      onClick={() => judgment('dailyJudge', false)}
                    >
                      <X size={18} /> Incorrect
                    </button>
                  </div>
                )}
                {host && (
                  <details className="host-answer">
                    <summary>Private correct response</summary>
                    <p>{s.question?.answer}</p>
                  </details>
                )}
              </section>
            )}
            {s.phase === 'reveal' && (
              <section className="panel reveal-stage">
                <span className="eyebrow">CORRECT RESPONSE</span>
                <h2>{s.question?.answer}</h2>
                <p className="muted">{s.question?.prompt}</p>
                <Standings s={s} />
                {control && (
                  <button
                    className="button primary"
                    disabled={busy || s.paused}
                    onClick={() => void send({ type: 'next' })}
                  >
                    {s.tiles.every((t) => t.used) ? 'On to Final Jeopardy' : 'Back to the board'}{' '}
                    <ArrowRight size={17} />
                  </button>
                )}
              </section>
            )}
            {s.phase === 'finalWager' && (
              <section className="question-stage final-stage">
                <Star size={37} />
                <span className="eyebrow">FINAL JEOPARDY</span>
                <h2>{s.finalCategory}</h2>
                <p>The category is revealed. How much are you willing to risk?</p>
                {player ? (
                  <form
                    className="wager-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void send({ type: 'wager', amount: Number(wager) });
                    }}
                  >
                    <label>
                      Your wager · max {money(max)}
                      <input
                        type="number"
                        min={0}
                        max={max}
                        step={1}
                        required
                        value={wager}
                        onChange={(e) => setWager(e.target.value)}
                      />
                    </label>
                    <button className="button primary" disabled={busy || s.paused}>
                      Save wager
                    </button>
                    <p role="status">
                      {finalEntry?.wager !== undefined
                        ? `Your wager: ${money(finalEntry.wager)}. You can change it until the host reveals the clue.`
                        : 'Your wager stays private until the reveal.'}
                    </p>
                  </form>
                ) : (
                  <>
                    <div className="submission-list">
                      {s.players.map((p) => (
                        <div key={p.id}>
                          <b>{p.name}</b>
                          <span>
                            {s.finalEntries[p.id]?.wager !== undefined
                              ? '✓ Wager saved'
                              : 'Waiting…'}
                          </span>
                        </div>
                      ))}
                    </div>
                    {control && (
                      <button
                        className="button primary"
                        disabled={busy || s.paused}
                        onClick={() => {
                          if (
                            s.players.some((p) => s.finalEntries[p.id]?.wager === undefined) &&
                            !confirm(
                              'Some players have not wagered. Continue with a $0 wager for them?',
                            )
                          )
                            return;
                          void send({ type: 'openFinal' });
                        }}
                      >
                        Lock wagers & reveal clue <ArrowRight size={16} />
                      </button>
                    )}
                  </>
                )}
              </section>
            )}
            {host && ['finalAnswer', 'finalReveal', 'finalReview'].includes(s.phase) && (
              <FinalSubmissions s={s} />
            )}
            {s.phase === 'finalAnswer' && (
              <section className="question-stage final-stage">
                <div className="question-top">
                  <span className="eyebrow">FINAL JEOPARDY · {s.finalCategory}</span>
                  {timer}
                </div>
                <h2>{s.finalPrompt}</h2>
                {player ? (
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const text = draftRef.current;
                      if (saveInFlight.current) return;
                      saveInFlight.current = true;
                      const ok = await send({ type: 'answer', text });
                      if (ok) {
                        lastSaved.current = text;
                        setDraftStatus('Saved');
                      }
                      saveInFlight.current = false;
                    }}
                  >
                    <label>
                      Your response
                      <textarea
                        autoFocus
                        rows={4}
                        value={draft}
                        maxLength={2000}
                        disabled={s.paused || remaining <= 0 || !connected}
                        onChange={(e) => {
                          setDraft(e.target.value);
                          draftRef.current = e.target.value;
                          setDraftStatus('Unsaved changes');
                        }}
                        placeholder="Make it count…"
                      />
                    </label>
                    <div className="button-row">
                      <button
                        className="button primary"
                        disabled={busy || s.paused || remaining <= 0 || !connected}
                      >
                        Save response
                      </button>
                      <span className="small" role="status">
                        {draftStatus || 'Your latest saved response locks when time runs out.'}
                      </span>
                    </div>
                    <p className="muted small">
                      Edits are saved automatically. Only text received before the server deadline
                      counts.
                    </p>
                  </form>
                ) : (
                  <p className="muted">
                    Players are writing their responses. The latest saved response locks at zero.
                  </p>
                )}
              </section>
            )}
            {s.phase === 'finalReveal' && (
              <section className="question-stage final-stage final-solution">
                <span className="eyebrow">FINAL JEOPARDY · CORRECT RESPONSE</span>
                <h2>{s.finalAnswer}</h2>
                <p>
                  Responses are locked. Review the correct response before revealing each player’s
                  response.
                </p>
                {control && (
                  <button
                    className="button primary"
                    disabled={busy || s.paused}
                    onClick={() => void send({ type: 'reviewFinal' })}
                  >
                    Reveal player responses <ArrowRight size={17} />
                  </button>
                )}
                {!host && <p role="status">Waiting for the host to reveal player responses.</p>}
              </section>
            )}
            {s.phase === 'finalReview' && (
              <section className="question-stage final-stage">
                <span className="eyebrow">FINAL JEOPARDY · THE REVEAL</span>
                {current ? (
                  <>
                    <h2>{current.name}’s moment.</h2>
                    {host || audience ? (
                      <>
                        <div className="answer-reveal">
                          <small>SUBMITTED RESPONSE</small>
                          <h3>
                            {s.finalEntries[current.id]?.text?.trim() ||
                              (host
                                ? finalSubmissionStatus(s.finalEntries[current.id])
                                : '(No response submitted)')}
                          </h3>
                          <p>Wager: {money(s.finalEntries[current.id]?.wager ?? 0)}</p>
                        </div>
                        {host && (
                          <details className="host-answer">
                            <summary>Correct response</summary>
                            <p>{s.finalAnswer}</p>
                          </details>
                        )}
                        {control && (
                          <div className="button-row centered">
                            <button
                              className="button success"
                              disabled={
                                busy || s.paused || !s.finalEntries[current.id]?.text?.trim()
                              }
                              onClick={() =>
                                void send({
                                  type: 'finalJudge',
                                  playerId: current.id,
                                  correct: true,
                                })
                              }
                            >
                              <Check size={18} /> Correct
                            </button>
                            <button
                              className="button danger"
                              disabled={busy || s.paused}
                              onClick={() =>
                                void send({
                                  type: 'finalJudge',
                                  playerId: current.id,
                                  correct: false,
                                })
                              }
                            >
                              <X size={18} /> Incorrect
                            </button>
                          </div>
                        )}
                      </>
                    ) : (
                      <p className="muted">
                        The host is reviewing this response. Your results appear below after each
                        judgment.
                      </p>
                    )}
                  </>
                ) : (
                  <>
                    <h2>All responses have been judged.</h2>
                    {control && (
                      <button
                        className="button primary"
                        disabled={busy || s.paused}
                        onClick={() => void send({ type: 'finish' })}
                      >
                        {s.players.filter(
                          (p) => p.score === Math.max(...s.players.map((p) => p.score)),
                        ).length > 1
                          ? 'Start sudden-death tiebreaker'
                          : 'Announce the winner'}{' '}
                        <Trophy size={18} />
                      </button>
                    )}
                  </>
                )}
                <div className="final-results">
                  {s.players
                    .filter((p) => s.finalEntries[p.id]?.judged)
                    .map((p) => (
                      <div className="final-result" key={p.id}>
                        <b>{p.name}</b>
                        <span>{s.finalEntries[p.id]?.text?.trim() || '(No response)'}</span>
                        <span className={s.finalEntries[p.id]?.correct ? 'positive' : 'negative'}>
                          {s.finalEntries[p.id]?.correct ? '+' : '−'}
                          {money(s.finalEntries[p.id]?.wager ?? 0)}
                        </span>
                      </div>
                    ))}
                </div>
              </section>
            )}
          </div>
          {!player && (
            <aside className="panel score-sidebar">
              <Standings s={s} compact />
              {control && (
                <>
                  <hr />
                  <div className="host-tools">
                    <span className="eyebrow">HOST CONTROLS</span>
                    <button
                      className="button secondary full"
                      disabled={busy}
                      onClick={() => void send({ type: s.paused ? 'continue' : 'pause' })}
                    >
                      {s.paused ? <Play size={16} /> : <Pause size={16} />}{' '}
                      {s.paused ? 'Continue game' : 'Pause game'}
                    </button>
                    {['question', 'answering', 'dailyWager', 'dailyAnswer'].includes(s.phase) && (
                      <button
                        className="button secondary full"
                        disabled={busy || s.paused}
                        onClick={() => {
                          if (
                            confirm(
                              'Reveal the correct response and close this clue without another score change?',
                            )
                          )
                            void send({ type: 'reveal' });
                        }}
                      >
                        Reveal & close clue
                      </button>
                    )}
                    {s.canUndo && (
                      <div className="clue-undo-controls">
                        <button
                          className="button secondary full"
                          disabled={busy || s.paused}
                          onClick={() => void send({ type: 'undo' })}
                        >
                          <RotateCcw size={16} /> Undo last judgment
                        </button>
                        <p className="muted small" role="status">
                          {s.undoCount ?? 1} {(s.undoCount ?? 1) === 1 ? 'judgment' : 'judgments'}{' '}
                          can be undone for this clue. Each undo returns to that player’s response
                          and cancels later buzzes.
                        </p>
                      </div>
                    )}
                    <DisplayAccess sessionId={id} />
                    <button
                      className="text-button negative"
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            'End this session? This cannot be resumed afterward. Results will be saved.',
                          )
                        )
                          void send({ type: 'end' });
                      }}
                    >
                      End session
                    </button>
                  </div>
                </>
              )}
            </aside>
          )}
        </div>
      )}
      {control && s.phase === 'lobby' && (
        <div className="lobby-end">
          <DisplayAccess sessionId={id} placement="lobby" />
          <button
            className="text-button negative"
            disabled={busy}
            onClick={() => {
              if (confirm('End this session permanently?')) void send({ type: 'end' });
            }}
          >
            End session
          </button>
        </div>
      )}
    </div>
  );
}
