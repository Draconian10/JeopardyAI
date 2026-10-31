'use client';
import { useState, type ReactNode } from 'react';
import { Check, X, Zap } from 'lucide-react';
import type { SessionView } from '@/lib/game/types';
import type { Command } from '@/lib/game/schema';
export default function Tiebreaker({
  s,
  player,
  host,
  userId,
  control,
  busy,
  canBuzz,
  timer,
  send,
}: {
  s: SessionView;
  player: boolean;
  host: boolean;
  userId: string;
  control: boolean;
  busy: boolean;
  canBuzz: boolean;
  timer: ReactNode;
  send: (command: Command) => Promise<boolean>;
}) {
  const [category, setCategory] = useState(''),
    [prompt, setPrompt] = useState(''),
    [answer, setAnswer] = useState('');
  const tie = s.tiebreaker!,
    round = tie.round;
  const eligible = tie.playerIds.includes(userId);
  const respondent = s.players.find((p) => p.id === s.respondent);
  const names = tie.playerIds.map((id) => s.players.find((p) => p.id === id)?.name).join(' · ');
  return (
    <section className="question-stage tie-stage">
      <span className="eyebrow">SUDDEN DEATH · TIEBREAKER {tie.roundNumber}</span>
      <p className="tie-contenders">{names}</p>
      <p className="tie-rules">No dollar value. A correct response is required to win.</p>
      {s.phase === 'tieSetup' ? (
        <>
          <h2>Tied for first. One correct response wins.</h2>
          {control ? (
            <form
              className="tie-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const ok = await send({ type: 'tieClue', category, prompt, answer });
                if (ok) {
                  setCategory('');
                  setPrompt('');
                  setAnswer('');
                }
              }}
            >
              <p>
                Enter a new clue privately, then open the buzzers. Players get 30 seconds to buzz.
              </p>
              <label>
                Tiebreaker category
                <input
                  required
                  maxLength={100}
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
              </label>
              <label>
                Tiebreaker clue
                <textarea
                  required
                  maxLength={3000}
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </label>
              <label>
                Tiebreaker answer
                <input
                  required
                  maxLength={2000}
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                />
              </label>
              <button
                className="button primary"
                disabled={busy || s.paused || !category.trim() || !prompt.trim() || !answer.trim()}
              >
                Present clue & open buzzers
              </button>
            </form>
          ) : (
            <p role="status">
              {player && !eligible
                ? 'Watch the tied leaders compete.'
                : 'The host is preparing the tiebreaker clue.'}
            </p>
          )}
        </>
      ) : (
        <>
          <div className="question-top">
            <span className="eyebrow">{round?.category}</span>
            {['tieQuestion', 'tieAnswer'].includes(s.phase) && timer}
          </div>
          {!player &&
            (s.phase === 'tieAnswer' ? (
              <h2 className="clue-hidden">Clue hidden while {respondent?.name} answers</h2>
            ) : (
              <h2>{round?.prompt}</h2>
            ))}
          {player && ['tieQuestion', 'tieAnswer'].includes(s.phase) && (
            <>
              <button
                className={`buzzer ${canBuzz ? 'ready' : ''} ${s.phase === 'tieAnswer' && s.respondent === userId ? 'won' : ''}`}
                disabled={!canBuzz}
                onClick={() => {
                  if (s.windowId) void send({ type: 'buzz', windowId: s.windowId });
                }}
              >
                <Zap size={44} />
                <b>
                  {s.phase === 'tieAnswer' && s.respondent === userId
                    ? 'YOU’RE UP!'
                    : canBuzz
                      ? 'BUZZ!'
                      : 'HOLD TIGHT'}
                </b>
              </button>
              <p className="buzzer-status" role="status">
                {!eligible
                  ? 'Only the tied leaders can buzz.'
                  : s.paused
                    ? 'Waiting for the game to resume'
                    : s.phase === 'tieAnswer'
                      ? s.respondent === userId
                        ? 'Give your response to the host.'
                        : `${respondent?.name} is answering`
                      : s.attempted.includes(userId)
                        ? 'You can try again on the next tiebreaker clue.'
                        : 'Buzz in with the correct response to win.'}
              </p>
            </>
          )}
          {!player && s.phase === 'tieQuestion' && (
            <p className="buzz-open">BUZZERS OPEN · TIED LEADERS ONLY</p>
          )}
          {!player && s.phase === 'tieAnswer' && (
            <div className="respondent">
              <b>{respondent?.name} is answering</b>
              {control && (
                <div className="button-row">
                  <button
                    className="button success"
                    disabled={busy || s.paused}
                    onClick={() => void send({ type: 'tieJudge', correct: true })}
                  >
                    <Check size={18} />
                    Correct · wins game
                  </button>
                  <button
                    className="button danger"
                    disabled={busy || s.paused}
                    onClick={() => void send({ type: 'tieJudge', correct: false })}
                  >
                    <X size={18} />
                    Incorrect
                  </button>
                </div>
              )}
            </div>
          )}
          {host && s.phase !== 'tieReveal' && (
            <details className="host-answer">
              <summary>Private host answer</summary>
              <p>{round?.answer}</p>
            </details>
          )}
          {s.phase === 'tieReveal' && (
            <div className="answer-reveal">
              <small>CORRECT RESPONSE</small>
              <h3>{round?.answer}</h3>
              <p>
                No correct response. No winner yet; all tied leaders remain eligible for the next
                clue.
              </p>
              {control && (
                <button
                  className="button primary"
                  disabled={busy || s.paused}
                  onClick={() => void send({ type: 'tieNext' })}
                >
                  Prepare another clue
                </button>
              )}
            </div>
          )}
          {control && ['tieQuestion', 'tieAnswer'].includes(s.phase) && (
            <button
              className="button secondary"
              disabled={busy || s.paused}
              onClick={() => {
                if (confirm('Reveal this clue without a winner and prepare another?'))
                  void send({ type: 'tieReveal' });
              }}
            >
              Reveal without a winner
            </button>
          )}
        </>
      )}
    </section>
  );
}
